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
import { loadKbConfig, type EnvSource, type KbConfig } from "../config.server.ts";
import { isIngestStatus, terminalErrorSummary, type IngestStatus } from "./ingest-state.ts";

export function kbConfigured(env?: EnvSource): boolean {
  const config = env ? loadKbConfig(env) : loadKbConfig();
  return Boolean(config.clusterArn && config.secretArn && config.database);
}

let _client: RDSDataClient | undefined;
let _clientRegion = "";
function client(region: string): RDSDataClient {
  if (!_client || _clientRegion !== region) {
    _client = new RDSDataClient({ region });
    _clientRegion = region;
  }
  return _client;
}

// Scale-to-0: the first Data API call after idle must wait for the cluster to
// resume (~15s), which surfaces as a transient error. Retry those (and throttle
// / 5xx) so the user's first save/search after idle doesn't just fail.
const RESUME_RE =
  /resum|not currently available|is not available|throttl|too many requests|timeout|serviceunavailable/i;

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

function requireConfig(): KbConfig {
  const config = loadKbConfig();
  if (!config.clusterArn || !config.secretArn || !config.database) {
    throw new Error("KB is not configured (set KB_CLUSTER_ARN, KB_SECRET_ARN, KB_DATABASE).");
  }
  return config;
}

// --- parameters --------------------------------------------------------------

/** Build a named Data API parameter, inferring the field type. */
export function param(name: string, value: string | number | boolean | null): SqlParameter {
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

/**
 * The RDS Data API for Aurora PostgreSQL rejects array-typed parameters
 * ("Array parameters are not supported"). Arrays travel as one delimited text
 * parameter and are split server-side with string_to_array(...) so they stay
 * bound parameters, never interpolated SQL. Values must not contain the
 * delimiter; every caller passes uuids, integers or enum tokens.
 */
export const LIST_DELIMITER = ",";

export function listParam(name: string, values: readonly (string | number)[]): SqlParameter {
  for (const value of values) {
    const text = String(value);
    if (!text || text.includes(LIST_DELIMITER) || /\s/.test(text)) {
      throw new Error(`invalid list value for ${name}`);
    }
  }
  return param(name, values.map(String).join(LIST_DELIMITER));
}

/** SQL fragment turning a listParam back into a typed array. */
export function listCast(name: string, type: "uuid" | "bigint" | "text"): string {
  return `CAST(string_to_array(:${name}, '${LIST_DELIMITER}') AS ${type}[])`;
}

// --- low-level execution -----------------------------------------------------

/** Run one statement. Returns the raw command output. */
export async function execute(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
) {
  const config = requireConfig();
  return sendWithRetry(() =>
    client(config.region).send(
      new ExecuteStatementCommand({
        resourceArn: config.clusterArn,
        secretArn: config.secretArn,
        database: config.database,
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
  const config = requireConfig();
  if (!sub) throw new Error("withPrincipal requires a verified principal");
  const begun = await sendWithRetry(() =>
    client(config.region).send(
      new BeginTransactionCommand({
        resourceArn: config.clusterArn,
        secretArn: config.secretArn,
        database: config.database,
      }),
    ),
  );
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error("KB: could not begin transaction");
  try {
    // set_config(..., is_local=true) == SET LOCAL: scoped to this transaction.
    await execute("SELECT set_config('app.user', :sub, true)", [param("sub", sub)], transactionId);
    const out = await fn(transactionId);
    await sendWithRetry(() =>
      client(config.region).send(
        new CommitTransactionCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
          transactionId,
        }),
      ),
    );
    return out;
  } catch (err) {
    try {
      await client(config.region).send(
        new RollbackTransactionCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
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
    param(
      "embedding",
      args.embedding && args.embedding.length ? vectorLiteral(args.embedding) : null,
    ),
    param("match", match),
    param("rrf_k", rrfK),
    param("snippet", snippetChars),
  ];
  if (restrict) parameters.push(listParam("doc_ids", args.docIds as string[]));
  const docIdsSql = restrict ? listCast("doc_ids", "uuid") : "NULL::uuid[]";

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
    listParam("ids", chunkIds),
  ];
  const sql = `
    SELECT chunk_id, doc_id, page_start, page_end, kind, content, conf
    FROM kb.fetch_chunks(:owner, CAST(:workspace AS uuid), :surface, ${listCast("ids", "bigint")})
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
  status?: IngestStatus;
  bdaInvocationArn?: string | null;
  bdaInputKey?: string | null;
  bdaOutputPrefix?: string | null;
  bdaOutputS3Uri?: string | null;
  bdaClientFileId?: string | null;
};

/**
 * Upsert a document row (dedup on (owner, workspace, sha256) when sha256 is set)
 * and return its doc_id. Runs under the tenant principal.
 */
export async function insertDocument(sub: string, d: KbDocumentInput): Promise<string> {
  requireConfig();
  const sql = `
    INSERT INTO kb.documents
      (owner_sub, workspace_id, surface, file_name, mime, sha256, byte_size,
       page_count, s3_key, converter, status, bda_invocation_arn, bda_input_key,
       bda_output_prefix, bda_output_s3_uri, bda_client_file_id)
    VALUES
      (:owner, CAST(:workspace AS uuid), :surface, :file_name, :mime, :sha256,
       :byte_size, :page_count, :s3_key, :converter, :status,
       :bda_invocation_arn, :bda_input_key, :bda_output_prefix,
       :bda_output_s3_uri, :bda_client_file_id)
    ON CONFLICT (owner_sub, workspace_id, sha256) DO UPDATE SET
      status = CASE
        WHEN kb.documents.status IN ('ready', 'error') THEN kb.documents.status
        ELSE EXCLUDED.status
      END,
      page_count = COALESCE(EXCLUDED.page_count, kb.documents.page_count),
      s3_key = COALESCE(EXCLUDED.s3_key, kb.documents.s3_key),
      converter = COALESCE(EXCLUDED.converter, kb.documents.converter),
      bda_invocation_arn = COALESCE(
        EXCLUDED.bda_invocation_arn,
        kb.documents.bda_invocation_arn
      ),
      bda_input_key = COALESCE(EXCLUDED.bda_input_key, kb.documents.bda_input_key),
      bda_output_prefix = COALESCE(
        EXCLUDED.bda_output_prefix,
        kb.documents.bda_output_prefix
      ),
      bda_output_s3_uri = COALESCE(
        EXCLUDED.bda_output_s3_uri,
        kb.documents.bda_output_s3_uri
      ),
      bda_client_file_id = COALESCE(
        EXCLUDED.bda_client_file_id,
        kb.documents.bda_client_file_id
      ),
      updated_at = now()
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
    param("bda_invocation_arn", d.bdaInvocationArn ?? null),
    param("bda_input_key", d.bdaInputKey ?? null),
    param("bda_output_prefix", d.bdaOutputPrefix ?? null),
    param("bda_output_s3_uri", d.bdaOutputS3Uri ?? null),
    param("bda_client_file_id", d.bdaClientFileId ?? null),
  ];
  const rows = await withPrincipal(sub, (tx) => queryJson<{ doc_id: string }>(sql, parameters, tx));
  const id = rows[0]?.doc_id;
  if (!id) throw new Error("insertDocument returned no doc_id");
  return id;
}

export async function updateDocumentStatus(
  sub: string,
  docId: string,
  status: IngestStatus,
  extra?: { s3Key?: string; pageCount?: number; error?: string },
): Promise<void> {
  if (!isIngestStatus(status)) throw new Error("invalid document ingest status");
  requireConfig();
  const sets = ["status = :status", "updated_at = now()"];
  const parameters: SqlParameter[] = [
    param("status", status),
    param("doc_id", docId),
    param("owner", sub),
  ];
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
    const approved = new Set([
      terminalErrorSummary("conversion"),
      terminalErrorSummary("processing"),
      terminalErrorSummary("limits"),
      terminalErrorSummary("configuration"),
      terminalErrorSummary("unknown"),
    ]).has(extra.error);
    parameters.push(
      param("error", approved ? extra.error.slice(0, 160) : terminalErrorSummary("unknown")),
    );
  }
  if (status !== "error") sets.push("error = NULL");
  if (status === "ready" || status === "error") {
    sets.push("ingest_completed_at = COALESCE(ingest_completed_at, now())");
  }
  const sql = `
    UPDATE kb.documents
    SET ${sets.join(", ")}
    WHERE owner_sub = :owner AND doc_id = CAST(:doc_id AS uuid)
  `;
  await withPrincipal(sub, (tx) => execute(sql, parameters, tx));
}

export type KbDocumentRecord = {
  doc_id: string;
  owner_sub: string;
  workspace_id: string;
  surface: KbSurface;
  file_name: string;
  mime: string | null;
  sha256: string | null;
  byte_size: number | null;
  page_count: number | null;
  s3_key: string | null;
  converter: string | null;
  status: IngestStatus;
  bda_invocation_arn: string | null;
  bda_input_key: string | null;
  bda_output_prefix: string | null;
  bda_output_s3_uri: string | null;
  bda_client_file_id: string | null;
};

const DOCUMENT_RECORD_COLUMNS = `
  doc_id, owner_sub, workspace_id, surface, file_name, mime, sha256, byte_size,
  page_count, s3_key, converter, status, bda_invocation_arn, bda_input_key,
  bda_output_prefix, bda_output_s3_uri, bda_client_file_id
`;

/** Exact owner-scoped lookup used after a worker resolves the principal from
 * the dedicated ingest-job mapping. There is deliberately no ARN-only lookup. */
export async function getDocumentById(
  sub: string,
  docId: string,
): Promise<KbDocumentRecord | null> {
  requireConfig();
  const rows = await withPrincipal(sub, (tx) =>
    queryJson<KbDocumentRecord>(
      `SELECT ${DOCUMENT_RECORD_COLUMNS}
       FROM kb.documents
       WHERE owner_sub = :owner AND doc_id = CAST(:doc_id AS uuid)
       LIMIT 1`,
      [param("owner", sub), param("doc_id", docId)],
      tx,
    ),
  );
  return rows[0] ?? null;
}

/** Owner/workspace-scoped hash lookup for idempotent registration. */
export async function getDocumentByWorkspaceSha(
  sub: string,
  workspaceId: string,
  sha256: string,
): Promise<KbDocumentRecord | null> {
  requireConfig();
  const rows = await withPrincipal(sub, (tx) =>
    queryJson<KbDocumentRecord>(
      `SELECT ${DOCUMENT_RECORD_COLUMNS}
       FROM kb.documents
       WHERE owner_sub = :owner
         AND workspace_id = CAST(:workspace AS uuid)
         AND sha256 = :sha256
       LIMIT 1`,
      [param("owner", sub), param("workspace", workspaceId), param("sha256", sha256.toLowerCase())],
      tx,
    ),
  );
  return rows[0] ?? null;
}

export type DocumentIngestPatch = {
  status?: IngestStatus;
  s3Key?: string | null;
  pageCount?: number | null;
  converter?: string | null;
  bdaInvocationArn?: string | null;
  bdaInputKey?: string | null;
  bdaOutputPrefix?: string | null;
  bdaOutputS3Uri?: string | null;
  bdaClientFileId?: string | null;
  errorKind?: "conversion" | "processing" | "limits" | "configuration" | "unknown";
  markStarted?: boolean;
  markCompleted?: boolean;
};

/**
 * Patch one exact owned document. Optional expected statuses make worker
 * transitions conditional without ever bypassing FORCE RLS.
 */
export async function updateDocumentIngest(
  sub: string,
  docId: string,
  patch: DocumentIngestPatch,
  expectedStatuses?: readonly IngestStatus[],
): Promise<boolean> {
  requireConfig();
  if (patch.status !== undefined && !isIngestStatus(patch.status)) {
    throw new Error("invalid document ingest status");
  }
  const sets = ["updated_at = now()"];
  const parameters: SqlParameter[] = [param("owner", sub), param("doc_id", docId)];
  const add = (column: string, name: string, value: string | number | boolean | null) => {
    sets.push(`${column} = :${name}`);
    parameters.push(param(name, value));
  };
  if (patch.status !== undefined) add("status", "status", patch.status);
  if (patch.s3Key !== undefined) add("s3_key", "s3_key", patch.s3Key);
  if (patch.pageCount !== undefined) {
    add("page_count", "page_count", patch.pageCount);
  }
  if (patch.converter !== undefined) {
    add("converter", "converter", patch.converter);
  }
  if (patch.bdaInvocationArn !== undefined) {
    add("bda_invocation_arn", "bda_invocation_arn", patch.bdaInvocationArn);
  }
  if (patch.bdaInputKey !== undefined) {
    add("bda_input_key", "bda_input_key", patch.bdaInputKey);
  }
  if (patch.bdaOutputPrefix !== undefined) {
    add("bda_output_prefix", "bda_output_prefix", patch.bdaOutputPrefix);
  }
  if (patch.bdaOutputS3Uri !== undefined) {
    add("bda_output_s3_uri", "bda_output_s3_uri", patch.bdaOutputS3Uri);
  }
  if (patch.bdaClientFileId !== undefined) {
    add("bda_client_file_id", "bda_client_file_id", patch.bdaClientFileId);
  }
  if (patch.errorKind !== undefined) {
    add("error", "error", terminalErrorSummary(patch.errorKind));
  } else if (patch.status && patch.status !== "error") {
    sets.push("error = NULL");
  }
  if (patch.markStarted) {
    sets.push("ingest_started_at = COALESCE(ingest_started_at, now())");
  }
  if (patch.markCompleted) {
    sets.push("ingest_completed_at = COALESCE(ingest_completed_at, now())");
  }
  const validSources: Readonly<Record<IngestStatus, readonly IngestStatus[]>> = {
    queued: ["queued"],
    converting: ["queued", "converting"],
    embedding: ["queued", "converting", "embedding"],
    ready: ["embedding", "ready"],
    error: ["queued", "converting", "embedding", "error"],
  };
  const guardedStatuses = patch.status
    ? (expectedStatuses ?? validSources[patch.status]).filter((status) =>
        validSources[patch.status!].includes(status),
      )
    : expectedStatuses;
  if (patch.status && !guardedStatuses?.length) return false;
  let expectedSql = "";
  if (guardedStatuses?.length) {
    parameters.push(listParam("expected_statuses", [...guardedStatuses]));
    expectedSql = `AND status = ANY(${listCast("expected_statuses", "text")})`;
  }
  const result = await withPrincipal(sub, (tx) =>
    execute(
      `UPDATE kb.documents
       SET ${sets.join(", ")}
       WHERE owner_sub = :owner
         AND doc_id = CAST(:doc_id AS uuid)
         ${expectedSql}`,
      parameters,
      tx,
    ),
  );
  return (result.numberOfRecordsUpdated ?? 0) > 0;
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

async function insertChunkBatches(
  config: KbConfig,
  transactionId: string,
  sql: string,
  sets: SqlParameter[][],
): Promise<void> {
  for (let i = 0; i < sets.length; i += CHUNK_INSERT_BATCH) {
    await sendWithRetry(() =>
      client(config.region).send(
        new BatchExecuteStatementCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
          database: config.database,
          sql,
          parameterSets: sets.slice(i, i + CHUNK_INSERT_BATCH),
          transactionId,
        }),
      ),
    );
  }
}

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
  const config = requireConfig();
  const sql = `
    INSERT INTO kb.chunks
      (doc_id, owner_sub, workspace_id, surface, chunk_index, page_start, page_end,
       kind, content, context, conf, token_count, embedding)
    SELECT
      d.doc_id, :owner, CAST(:workspace AS uuid), :surface, :chunk_index,
      :page_start, :page_end, :kind, :content, :context, :conf, :token_count,
      CAST(:embedding AS vector)
    FROM kb.documents d
    WHERE d.doc_id = CAST(:doc_id AS uuid)
      AND d.owner_sub = :owner
      AND d.workspace_id = CAST(:workspace AS uuid)
      AND d.surface = :surface
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
    await insertChunkBatches(config, tx, sql, sets);
  });
}

/**
 * Atomically replace every chunk for an exact owned document. Replays cannot
 * leave stale tail chunks when a converter emits fewer rows on a later run.
 */
export async function replaceDocumentChunks(
  sub: string,
  docId: string,
  workspaceId: string,
  surface: KbSurface,
  rows: KbChunkRow[],
): Promise<void> {
  const config = requireConfig();
  const insertSql = `
    INSERT INTO kb.chunks
      (doc_id, owner_sub, workspace_id, surface, chunk_index, page_start, page_end,
       kind, content, context, conf, token_count, embedding)
    SELECT
      d.doc_id, :owner, CAST(:workspace AS uuid), :surface, :chunk_index,
      :page_start, :page_end, :kind, :content, :context, :conf, :token_count,
      CAST(:embedding AS vector)
    FROM kb.documents d
    WHERE d.doc_id = CAST(:doc_id AS uuid)
      AND d.owner_sub = :owner
      AND d.workspace_id = CAST(:workspace AS uuid)
      AND d.surface = :surface
    ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
      content = EXCLUDED.content, context = EXCLUDED.context, conf = EXCLUDED.conf,
      token_count = EXCLUDED.token_count, embedding = EXCLUDED.embedding
  `;
  const sets: SqlParameter[][] = rows.map((row) => [
    param("doc_id", docId),
    param("owner", sub),
    param("workspace", workspaceId),
    param("surface", surface),
    param("chunk_index", row.chunkIndex),
    param("page_start", row.pageStart),
    param("page_end", row.pageEnd),
    param("kind", row.kind),
    param("content", row.content),
    param("context", row.context ?? null),
    param("conf", row.conf ?? null),
    param("token_count", row.tokenCount ?? null),
    param("embedding", row.embedding ? vectorLiteral(row.embedding) : null),
  ]);
  await withPrincipal(sub, async (tx) => {
    await execute(
      `DELETE FROM kb.chunks
       WHERE owner_sub = :owner
         AND workspace_id = CAST(:workspace AS uuid)
         AND surface = :surface
         AND doc_id = CAST(:doc_id AS uuid)`,
      [
        param("owner", sub),
        param("workspace", workspaceId),
        param("surface", surface),
        param("doc_id", docId),
      ],
      tx,
    );
    if (sets.length) {
      await insertChunkBatches(config, tx, insertSql, sets);
    }
  });
}

export type KbDeletedDocument = {
  doc_id: string;
  s3_key: string | null;
  bda_input_key: string | null;
  bda_output_prefix: string | null;
};

/**
 * Delete every document owned by the principal in a workspace. Chunk rows are
 * removed by the documents -> chunks ON DELETE CASCADE constraint. Returning
 * the document ids lets the cross-store cleanup derive page-object keys even
 * when a save stopped before its DynamoDB manifest was finalized.
 */
export async function deleteWorkspaceDocuments(
  sub: string,
  workspaceId: string,
): Promise<KbDeletedDocument[]> {
  requireConfig();
  const sql = `
    DELETE FROM kb.documents
    WHERE owner_sub = :owner AND workspace_id = CAST(:workspace AS uuid)
    RETURNING doc_id, s3_key, bda_input_key, bda_output_prefix
  `;
  const parameters: SqlParameter[] = [param("owner", sub), param("workspace", workspaceId)];
  return withPrincipal(sub, (tx) => queryJson<KbDeletedDocument>(sql, parameters, tx));
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
