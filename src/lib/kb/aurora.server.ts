// ============================================================================
// KB data access — Aurora PostgreSQL + pgvector via the RDS Data API.
// Server-only. Uses the default AWS credential chain (SSO in dev, scoped IAM
// role in prod) — no static keys, SigV4 by the SDK. HTTP Data API means no VPC
// connection pool, which fits Aurora Serverless v2 + Lambda.
//
// Tenancy: every call runs inside a transaction that first sets the `app.user`
// GUC from the VERIFIED Cognito principal, so the FORCED row-level security in
// db/kb/0001_kb_init.sql scopes the connection. Never pass a client-supplied
// principal here — derive it from getUserFromRequest.
//
// Dormant until KB_CLUSTER_ARN / KB_SECRET_ARN / KB_DATABASE are set; callers
// should gate on kbConfigured().
// ============================================================================
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const CLUSTER_ARN = process.env["KB_CLUSTER_ARN"] ?? "";
const SECRET_ARN = process.env["KB_SECRET_ARN"] ?? "";
const DATABASE = process.env["KB_DATABASE"] ?? "";

export function kbConfigured(): boolean {
  return Boolean(CLUSTER_ARN && SECRET_ARN && DATABASE);
}

let _client: RDSDataClient | undefined;
function client(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: REGION });
  return _client;
}

function requireConfig(): void {
  if (!kbConfigured()) {
    throw new Error(
      "KB is not configured (set KB_CLUSTER_ARN, KB_SECRET_ARN, KB_DATABASE).",
    );
  }
}

// --- parameters --------------------------------------------------------------

/** Build a named Data API parameter, inferring the field type. */
export function param(
  name: string,
  value: string | number | boolean | null,
): SqlParameter {
  if (value === null) return { name, value: { isNull: true } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  return { name, value: { stringValue: value } };
}

/** pgvector text literal: "[0.1,0.2,...]". */
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// --- low-level execution -----------------------------------------------------

/** Run one statement. Returns the raw command output. */
export async function execute(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
) {
  requireConfig();
  return client().send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      sql,
      parameters: parameters.length ? parameters : undefined,
      transactionId,
      formatRecordsAs: "JSON",
    }),
  );
}

/** Run a query and parse the JSON-formatted rows into T[]. */
export async function queryJson<T>(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
): Promise<T[]> {
  const res = await execute(sql, parameters, transactionId);
  if (!res.formattedRecords) return [];
  return JSON.parse(res.formattedRecords) as T[];
}

/**
 * Run `fn` inside a transaction with the tenant principal set for RLS.
 * `sub` MUST be the verified Cognito principal (getUserFromRequest), never
 * client input. Commits on success, rolls back on any error.
 */
export async function withPrincipal<T>(
  sub: string,
  fn: (transactionId: string) => Promise<T>,
): Promise<T> {
  requireConfig();
  if (!sub) throw new Error("withPrincipal requires a verified principal");
  const begun = await client().send(
    new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
    }),
  );
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error("KB: could not begin transaction");
  try {
    // set_config(..., is_local=true) == SET LOCAL: scoped to this transaction.
    await execute(
      "SELECT set_config('app.user', :sub, true)",
      [param("sub", sub)],
      transactionId,
    );
    const out = await fn(transactionId);
    await client().send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    );
    return out;
  } catch (err) {
    try {
      await client().send(
        new RollbackTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      );
    } catch {
      /* rollback best-effort; surface the original error */
    }
    throw err;
  }
}

// --- hybrid search -----------------------------------------------------------

export type KbSurface = "workingset" | "deposition" | "review";

export type KbHit = {
  chunk_id: number;
  doc_id: string;
  page_start: number | null;
  page_end: number | null;
  kind: string | null;
  content: string;
  conf: number | null;
  score: number;
};

export type HybridSearchArgs = {
  /** Verified Cognito principal. */
  sub: string;
  workspaceId: string;
  surface: KbSurface;
  query: string;
  /** Titan v2 query embedding, 1024-dim. */
  embedding: number[];
  /** Fused candidate ceiling before app-side rerank. */
  match?: number;
  rrfK?: number;
  /**
   * Per-row snippet length (chars) returned as rerank input. Bounded because the
   * Data API hard-errors past 1 MiB total / 64 KB per row; full bodies for the
   * reranked top-K come from fetchChunks(). NEVER widen this to return whole
   * documents.
   */
  snippetChars?: number;
  /** Optional restrict-to set of document ids. */
  docIds?: string[];
};

/**
 * Hybrid RRF search (pgvector kNN + BM25) scoped to the tenant + surface.
 * Runs under withPrincipal so RLS applies; owner/workspace are also passed
 * explicitly to the function (defense in depth). Returns bounded snippets, not
 * full bodies (Data API 1 MiB / 64 KB caps).
 */
export async function hybridSearch(args: HybridSearchArgs): Promise<KbHit[]> {
  requireConfig();
  const match = args.match ?? 120;
  const rrfK = args.rrfK ?? 60;
  const snippetChars = args.snippetChars ?? 2500;
  const restrict = args.docIds?.length ? true : false;

  const parameters: SqlParameter[] = [
    param("owner", args.sub),
    param("workspace", args.workspaceId),
    param("surface", args.surface),
    param("query", args.query),
    param("embedding", vectorLiteral(args.embedding)),
    param("match", match),
    param("rrf_k", rrfK),
    param("snippet", snippetChars),
  ];
  if (restrict) {
    parameters.push({
      name: "doc_ids",
      value: { arrayValue: { stringValues: args.docIds as string[] } },
    });
  }
  const docIdsSql = restrict ? "CAST(:doc_ids AS uuid[])" : "NULL::uuid[]";

  const sql = `
    SELECT chunk_id, doc_id, page_start, page_end, kind, content, conf, score
    FROM kb.hybrid_search(
      :owner,
      CAST(:workspace AS uuid),
      :surface,
      :query,
      CAST(:embedding AS vector),
      CAST(:match AS int),
      CAST(:rrf_k AS int),
      CAST(:snippet AS int),
      ${docIdsSql}
    )
  `;

  return withPrincipal(args.sub, (tx) => queryJson<KbHit>(sql, parameters, tx));
}

export type KbChunk = {
  chunk_id: number;
  doc_id: string;
  page_start: number | null;
  page_end: number | null;
  kind: string | null;
  content: string;
  conf: number | null;
};

/**
 * Full chunk bodies for the reranked top-K (synthesis input). Keep `chunkIds`
 * bounded (<= ~40) so the 1 MiB Data API result cap is not exceeded; per-row
 * content is < 64 KB by the ingest chunk-size cap. Order follows `chunkIds`.
 */
export async function fetchChunks(
  sub: string,
  workspaceId: string,
  surface: KbSurface,
  chunkIds: number[],
): Promise<KbChunk[]> {
  if (!chunkIds.length) return [];
  requireConfig();
  const parameters: SqlParameter[] = [
    param("owner", sub),
    param("workspace", workspaceId),
    param("surface", surface),
    {
      name: "ids",
      value: { arrayValue: { longValues: chunkIds } },
    },
  ];
  const sql = `
    SELECT chunk_id, doc_id, page_start, page_end, kind, content, conf
    FROM kb.fetch_chunks(:owner, CAST(:workspace AS uuid), :surface, CAST(:ids AS bigint[]))
  `;
  return withPrincipal(sub, (tx) => queryJson<KbChunk>(sql, parameters, tx));
}
