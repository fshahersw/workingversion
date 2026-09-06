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
  BatchExecuteStatementCommand,
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

// Scale-to-0: the first Data API call after idle must wait for the cluster to
// resume (~15s), which surfaces as a transient error. Retry those (and throttle
// / 5xx) so the user's first save/search after idle doesn't just fail.
const RESUME_RE = /resum|not currently available|is not available|throttl|too many requests|timeout|serviceunavailable/i;

async function sendWithRetry<T>(fn: () => Promise<T>, tries = 8, delayMs = 3000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      const msg = `${err?.name ?? ""} ${err?.message ?? ""}`;
      const status = err?.$metadata?.httpStatusCode ?? 0;
      if (attempt < tries && (RESUME_RE.test(msg) || status === 429 || status >= 500)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
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
  return sendWithRetry(() =>
    client().send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql,
        parameters: parameters.length ? parameters : undefined,
        transactionId,
        formatRecordsAs: "JSON",
      }),
    ),
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
  const begun = await sendWithRetry(() =>
    client().send(
      new BeginTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
      }),
    ),
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
    await sendWithRetry(() =>
      client().send(
        new CommitTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      ),
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
  /** Titan v2 query embedding, 1024-dim. Null runs lexical-only (BM25) when the
   *  embedder is unavailable — hybrid_search skips the vector leg on NULL. */
  embedding: number[] | null;
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
    param("embedding", args.embedding && args.embedding.length ? vectorLiteral(args.embedding) : null),
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

// --- writes (ingest) ---------------------------------------------------------

export type KbDocumentInput = {
  workspaceId: string;
  surface: KbSurface;
  fileName: string;
  mime?: string | null;
  sha256?: string | null;
  byteSize?: number | null;
  pageCount?: number | null;
  s3Key?: string | null;
  converter?: string | null;
  status?: string;
};

/**
 * Upsert a document row (dedup on (owner, workspace, sha256) when sha256 is set)
 * and return its doc_id. Runs under the tenant principal.
 */
export async function insertDocument(sub: string, d: KbDocumentInput): Promise<string> {
  requireConfig();
  const sql = `
    INSERT INTO kb.documents
      (owner_sub, workspace_id, surface, file_name, mime, sha256, byte_size, page_count, s3_key, converter, status)
    VALUES
      (:owner, CAST(:workspace AS uuid), :surface, :file_name, :mime, :sha256, :byte_size, :page_count, :s3_key, :converter, :status)
    ON CONFLICT (owner_sub, workspace_id, sha256) DO UPDATE SET
      status = EXCLUDED.status, page_count = EXCLUDED.page_count, s3_key = EXCLUDED.s3_key,
      converter = EXCLUDED.converter, updated_at = now()
    RETURNING doc_id
  `;
  const parameters: SqlParameter[] = [
    param("owner", sub),
    param("workspace", d.workspaceId),
    param("surface", d.surface),
    param("file_name", d.fileName),
    param("mime", d.mime ?? null),
    param("sha256", d.sha256 ?? null),
    param("byte_size", d.byteSize ?? null),
    param("page_count", d.pageCount ?? null),
    param("s3_key", d.s3Key ?? null),
    param("converter", d.converter ?? null),
    param("status", d.status ?? "queued"),
  ];
  const rows = await withPrincipal(sub, (tx) =>
    queryJson<{ doc_id: string }>(sql, parameters, tx),
  );
  const id = rows[0]?.doc_id;
  if (!id) throw new Error("insertDocument returned no doc_id");
  return id;
}

export async function updateDocumentStatus(
  sub: string,
  docId: string,
  status: string,
  extra?: { s3Key?: string; pageCount?: number; error?: string },
): Promise<void> {
  requireConfig();
  const sets = ["status = :status", "updated_at = now()"];
  const parameters: SqlParameter[] = [param("status", status), param("doc_id", docId)];
  if (extra?.s3Key !== undefined) {
    sets.push("s3_key = :s3_key");
    parameters.push(param("s3_key", extra.s3Key));
  }
  if (extra?.pageCount !== undefined) {
    sets.push("page_count = :page_count");
    parameters.push(param("page_count", extra.pageCount));
  }
  if (extra?.error !== undefined) {
    sets.push("error = :error");
    parameters.push(param("error", extra.error.slice(0, 2000)));
  }
  const sql = `UPDATE kb.documents SET ${sets.join(", ")} WHERE doc_id = CAST(:doc_id AS uuid)`;
  await withPrincipal(sub, (tx) => execute(sql, parameters, tx));
}

export type KbChunkRow = {
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  kind: string;
  content: string;
  context?: string | null;
  conf?: number | null;
  tokenCount?: number | null;
  embedding: number[] | null;
};

const CHUNK_INSERT_BATCH = 25;

/** Batch-insert chunks (idempotent on (doc_id, chunk_index)), under the tenant
 *  principal so the RLS WITH CHECK passes. Batched to respect the Data API
 *  4 MiB request-body limit. */
export async function insertChunks(
  sub: string,
  docId: string,
  workspaceId: string,
  surface: KbSurface,
  rows: KbChunkRow[],
): Promise<void> {
  if (!rows.length) return;
  requireConfig();
  const sql = `
    INSERT INTO kb.chunks
      (doc_id, owner_sub, workspace_id, surface, chunk_index, page_start, page_end,
       kind, content, context, conf, token_count, embedding)
    VALUES
      (CAST(:doc_id AS uuid), :owner, CAST(:workspace AS uuid), :surface, :chunk_index,
       :page_start, :page_end, :kind, :content, :context, :conf, :token_count,
       CAST(:embedding AS vector))
    ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
      content = EXCLUDED.content, context = EXCLUDED.context, conf = EXCLUDED.conf,
      token_count = EXCLUDED.token_count, embedding = EXCLUDED.embedding
  `;
  const sets: SqlParameter[][] = rows.map((r) => [
    param("doc_id", docId),
    param("owner", sub),
    param("workspace", workspaceId),
    param("surface", surface),
    param("chunk_index", r.chunkIndex),
    param("page_start", r.pageStart),
    param("page_end", r.pageEnd),
    param("kind", r.kind),
    param("content", r.content),
    param("context", r.context ?? null),
    param("conf", r.conf ?? null),
    param("token_count", r.tokenCount ?? null),
    param("embedding", r.embedding ? vectorLiteral(r.embedding) : null),
  ]);
  await withPrincipal(sub, async (tx) => {
    for (let i = 0; i < sets.length; i += CHUNK_INSERT_BATCH) {
      await sendWithRetry(() =>
        client().send(
          new BatchExecuteStatementCommand({
            resourceArn: CLUSTER_ARN,
            secretArn: SECRET_ARN,
            database: DATABASE,
            sql,
            parameterSets: sets.slice(i, i + CHUNK_INSERT_BATCH),
            transactionId: tx,
          }),
        ),
      );
    }
  });
}

export type KbDocumentRow = {
  doc_id: string;
  file_name: string;
  page_count: number | null;
  status: string;
  created_at: string;
  chunk_count: number;
};

/** The user's saved documents for a surface (most recent first), with a chunk
 *  count so the UI can show what was indexed. RLS-scoped to the principal. */
export async function listDocuments(
  sub: string,
  workspaceId: string,
  surface: KbSurface,
): Promise<KbDocumentRow[]> {
  requireConfig();
  const sql = `
    SELECT d.doc_id, d.file_name, d.page_count, d.status, d.created_at,
           (SELECT count(*) FROM kb.chunks c WHERE c.doc_id = d.doc_id) AS chunk_count
    FROM kb.documents d
    WHERE d.owner_sub = :owner AND d.workspace_id = CAST(:workspace AS uuid) AND d.surface = :surface
    ORDER BY d.created_at DESC
    LIMIT 200
  `;
  const parameters: SqlParameter[] = [
    param("owner", sub),
    param("workspace", workspaceId),
    param("surface", surface),
  ];
  return withPrincipal(sub, (tx) => queryJson<KbDocumentRow>(sql, parameters, tx));
}
