# KB Architecture

Detailed technical architecture of the per-user document KB. See
[OVERVIEW.md](OVERVIEW.md) for the what/why and [OPERATIONS.md](OPERATIONS.md) for
provisioning/runbook.

## Production stack (AWS-native only)

| Concern               | Service                                    | Notes                                                                                                 |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Auth / identity       | Amazon Cognito (OIDC + PKCE)               | principal = verified id-token `sub`; httpOnly `sw_id` cookie                                          |
| Relational + vector   | Aurora PostgreSQL Serverless v2 + pgvector | cluster `sw-kb-kb`, private, RDS Data API, FORCE RLS                                                  |
| Blobs                 | Amazon S3 (SSE-KMS)                        | existing app-data bucket supplied by parameter; owned byte/page/BDA prefixes                          |
| Metadata / records    | Existing app DynamoDB table                | library items, folders, and per-document workspace checkpoints                                        |
| Async job correlation | Dedicated DynamoDB table                   | ARN/id → owner/doc/workspace/fingerprint, `StatusUpdated` GSI, TTL/PITR/CMK; no document content       |
| Conversion            | Bedrock Data Automation                    | deterministic `clientToken`; EventBridge notifications enabled                                        |
| Completion delivery   | EventBridge → encrypted SQS → Lambda       | exact BDA success/client-error/service-error events, partial batch failures, DLQ, bounded concurrency |
| Reconciliation        | EventBridge schedule → Lambda              | restarts stale queued reservations; polls stale mapped jobs and enqueues the same compact event        |
| Embeddings            | Bedrock Titan Text Embeddings V2           | `amazon.titan-embed-text-v2:0`, 1024-dim, cosine                                                      |
| Rerank                | Bedrock Rerank                             | `cohere.rerank-v3-5:0` via `bedrock-agent-runtime`                                                    |
| Credentials           | SigV4 default chain                        | SSO in dev, scoped IAM role in prod; no static keys                                                   |

Legacy (being retired, NOT used by the KB): Supabase, Voyage, Lovable gateway.

> **NO DEPLOY / NO MIGRATION:** This phase only implements and validates the
> asynchronous lane locally. No stack, change set, artifact upload, AWS API
> invocation, or database migration was run.

## The four-artifact workspace model

"Saving" a working set persists **four** things so it reloads one-click into a
fully queryable state:

| #   | Artifact                          | Store                                    | Purpose                                                                        |
| --- | --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Chunks + embeddings               | Aurora `kb.chunks`                       | server-side hybrid search — no re-embed on reload                              |
| 2   | Extracted pages (`{page,text}[]`) | S3 `kb/pages/<sub>/<docId>.json`         | one-click pile rehydrate (instant local search + reader)                       |
| 3   | Original file bytes               | S3 (presigned PUT, best-effort)          | the actual document, re-openable/downloadable                                  |
| 4   | Workspace record                  | DynamoDB library item (`type=workspace`) | Library browse/organize (name, surface, folder, doc manifest, `kbWorkspaceId`) |

Each saved workspace gets its own **`kbWorkspaceId`** (a UUID) so its chunks are a
separate KB partition and searching a reloaded workspace queries only its docs.

## Aurora schema (`db/kb/0001_kb_init.sql`, `0002_kb_async_ingest.sql`)

Schema `kb`, applied to database `kb`.

- **`kb.documents`** — one row per ingested file: `doc_id`, `owner_sub`,
  `workspace_id`, `surface` (`workingset|deposition|review`), `file_name`, `mime`,
  `sha256`, `page_count`, `s3_key`, `converter`, `status`. Unique on
  `(owner_sub, workspace_id, sha256)` for dedup.
- **`kb.chunks`** — page-anchored chunks: `chunk_id`, `doc_id`, `owner_sub`,
  `workspace_id`, `surface`, `chunk_index`, `page_start/end`, `kind`, `content`
  (verbatim), `context` (embed-only contextual prefix), `conf`, `token_count`,
  `tsv` (generated `tsvector` over content+context for BM25), `embedding vector(1024)`.
  Indexes: HNSW `vector_cosine_ops`, GIN on `tsv`, btree on
  `(owner_sub, workspace_id, surface)`.
- **`kb.hybrid_search(...)`** — RRF fuse of pgvector kNN + BM25 (`ts_rank`) in one
  round trip, scoped to `(owner, workspace, surface)`, optional `doc_ids` restrict.
  Returns a **bounded snippet** (`left(content, p_snippet_chars)`), never the
  embedding column (Data API size caps — see below).
- **`kb.fetch_chunks(...)`** — full chunk bodies for a bounded top-K (synthesis).
- **RLS:** `ENABLE` + **`FORCE`** row-level security on both tables; policy
  `owner_sub = current_setting('app.user', true)`. Least-privilege role `kb_app`.
- **Async metadata (0002):** owner-scoped BDA invocation, input key, output
  prefix/result URI, client file id, and ingest timestamps. Status is constrained to
  `queued|converting|embedding|ready|error`. No ARN-only/global lookup exists.
  Workers first resolve the dedicated DynamoDB mapping, then call Aurora only
  through `withPrincipal(ownerSub)`.

## Access seam (`src/lib/kb/aurora.server.ts`)

Server-only, via the **RDS Data API** (`@aws-sdk/client-rds-data`), default
credential chain. Key pieces:

- `withPrincipal(sub, fn)` — opens a Data API transaction, runs
  `SELECT set_config('app.user', :sub, true)` as its own statement, then `fn(tx)`,
  commit/rollback. Because a Data API transaction is a single serialized backend
  session, the transaction-local GUC holds for the transaction → **FORCE RLS scopes
  every query to the verified principal**. (A session-level `SET` would risk leaking
  across pooled connections — deliberately avoided.)
- `sendWithRetry(...)` — retries resume/throttle/5xx so the first request after a
  scale-to-0 cold start waits (~15s) instead of failing.
- Reads: `hybridSearch`, `fetchChunks`, `listDocuments`.
- Writes: `insertDocument` (upsert/dedup), `updateDocumentStatus`, `insertChunks`
  (`BatchExecuteStatement`, 25/batch, embedding cast to `vector`).
- `param()` / `vectorLiteral()` helpers; `kbConfigured()` gate on
  `KB_CLUSTER_ARN` / `KB_SECRET_ARN` / `KB_DATABASE`.

### Data API constraints the schema is designed around

- **1 MiB per result set, 64 KB per row — hard errors, not truncation.**
  `hybrid_search` returns bounded snippets, default `match` 120; never selects the
  embedding column (a 1024-float vector as text is ~10–15 KB/row).
- **No multi-statement calls** — the migration apply script splits statements; RLS
  `set_config` is its own statement inside the transaction.
- **Scale-to-0** — first call after idle pays ~15s resume (handled by retry).

## Ingest pipeline

Modules (all under `src/lib/kb/`, pure ones unit-tested):

1. **`canonical.ts`** — the one shape every source converts to: `CanonicalDoc` →
   `Page[]` → `Block[]` (`heading|para|list|table|figure`), tables first-class,
   page = citation anchor, text verbatim.
2. **`convert.ts`** — parsed source → canonical: `markdownToBlocks`,
   `bdaToCanonical` (BDA markdown + `[page N]` markers), `sheetsToCanonical`,
   `textToCanonical`, `pagesToCanonical` (browser-extracted `{page,text}[]` — the
   sync path).
3. **`chunk.ts`** — `chunkDocument`: structure- + table-aware, page-anchored.
   Prose grouped to a target size with overlap **within a section + page only**;
   headings/pages/tables/figures are hard boundaries (prose never spans pages).
   Tables split into row-groups that repeat the header. Content capped under the
   64 KB/row limit.
4. **`embed.ts`** — `contextualize` (deterministic doc/section/page prefix) +
   `embedChunks` (bounded-concurrency Titan v2, retry; embedder injectable for tests).
5. **`ingest.server.ts`** — `ingestCanonicalDoc` / `ingestPages` remain the
   synchronous compatibility API. `processExistingCanonicalDoc` reuses an
   already-registered `docId`, atomically replaces chunk rows, and treats a
   ready document as an idempotent replay.
6. **`ingest-async.server.ts`** — dependency-injectable BDA registration,
   completion/failure handling, result validation, canonical conversion,
   page persistence, existing-document processing, workspace checkpointing,
   and stale-job reconciliation.
7. **`ingest-job-store.server.ts`** — exact conditional writes to the dedicated
   correlation table. A stable token row, including request/raw-byte
   fingerprints, is linked to an exact BDA invocation ARN/`job_id` alias;
   workers never scan/query Aurora for an invocation ARN.

## Retrieval pipeline

- **`search.server.ts`** — `searchKb`: embed query (Titan) → `kb.hybrid_search`
  (pgvector + BM25 RRF) → **Bedrock rerank** (`cohere.rerank-v3-5:0`) → top-K.
  Degrades gracefully: lexical-only if the embedder fails, fused order if rerank
  fails. Bedrock/Titan imports are lazy so the module is node-testable.
- **`ask.server.ts`** — `askSavedWorkspace`: resolve the owned workspace, search
  or reuse follow-up chunk ids, `fetch_chunks` the full bodies, then stream the
  existing Working Set writer events. Unsaved or mutated piles stay on the
  local BM25 path.
- **`rerank-parse.ts`** — pure parser for the Bedrock Rerank response (identity
  fallback), unit-tested.

## Workspaces (Library integration)

- **`workspace.server.ts`** — idempotent workspace reservations plus one
  owner-scoped child checkpoint per document
  (`WSDOC#<workspaceItemId>#<clientFileId>`). Parent state is aggregated:
  `saving` while any child is queued/converting/embedding, `ready` only when all
  expected children are ready, and `error` after any terminal failure.
  Workspace detail exposes each child's queued/converting/embedding/ready/error
  progress without exposing job ARNs or storage keys. It also provides
  `listWorkspaces` (by surface),
  `getWorkspace`, `getWorkspacePages` (S3 → rehydrate, ownership-checked),
  `getWorkspaceDownloadUrl` (bytes), `deleteWorkspace` (removes pending job
  mappings, Aurora chunks, owned S3 pages/bytes/BDA outputs, checkpoints, then
  metadata), `putWorkspacePages` (pages → S3).
- **`workspace.functions.ts`** — `saveWorkspaceFn` keeps ordinary files on the
  bounded synchronous path and routes unreadable/oversized files with an owned
  `bytesKey` plus raw-byte SHA-256 to BDA. It returns explicit
  `status`, `stage`, and `pendingCount`; `getWorkspaceStatusFn` supports
  owner-scoped polling after submission.

## Client

- **`src/lib/use-pile.ts`** (the Working Set hook):
  - retains original `File` blobs by pile file id so duplicate names cannot attach
    the wrong bytes;
  - `saveWorkspace(name, folderId)` — uploads bytes (library presigned PUT),
    gathers pages, calls `saveWorkspaceFn`, then binds pile file ids to Aurora
    `docId`s so later Asks can stay on the saved workspace;
  - `reloadWorkspace(itemId)` — `getWorkspaceFn` + `getWorkspacePagesFn` per doc →
    build `PileFile`/`PilePage` → `ingestPages` rehydrate with the same binding;
  - adding or OCR-mutating files drops `savedWorkspace` so Ask cannot silently
    omit the new local pages;
  - IndexedDB store namespaced by Cognito `sub` (shared-workstation fix).
- **`src/lib/pile/kb-binding.ts`** — fail-closed helpers: a session is only
  "saved" when every pile file has a unique Aurora `docId`.
- **`src/components/summarize/SummarizeView.tsx`** — "Save workspace" name+folder
  popover; reads `sessionStorage["kb:reloadWorkspace"]` on mount to trigger reload.
- **`src/routes/_authenticated/library.tsx`** — Working Sets / Depositions /
  Tabular Review tabs; `WorkspacesList` lists + Open (sessionStorage handoff) + Delete.
- **`src/lib/kb/kb-client.ts`** — `streamSavedWorkspaceAsk` plus the earlier
  `ingestFileToKb` / `searchKbApi` / `listKbDocuments` helpers.

## API surface

Server functions (`createServerFn`, requireAuth): `saveWorkspaceFn`,
`listWorkspacesFn`, `getWorkspaceFn`, `getWorkspacePagesFn`, `deleteWorkspaceFn`,
plus the library `createUploadFn` (byte presign).

File routes (`createFileRoute`, gated by `apiAuthMiddleware`, principal via
`getUserFromRequest`): `POST /api/kb/ask`, `POST /api/kb/ingest`,
`POST /api/kb/search`, `GET /api/kb/documents`. The Ask route is the live
Working Set path for a complete saved snapshot. Ingest/search/documents remain
valid for the earlier default-workspace helpers. Action-less ingest requests
remain synchronous; discriminated `prepare`, `start`, `status`, and
`status-batch` actions expose the async lane without returning invocation ARNs.

## Data-flow summaries

```
SAVE WORKSPACE
  browser (pile pages + File blobs)
    -> Web Crypto SHA-256 + checksum-bound presign+PUT bytes to S3 (per file)
    -> saveWorkspaceFn { requestId, name, surface, folderId, files:[...] }
         reserve DynamoDB item (itemId = kbWorkspaceId = requestId; status=saving)
         reserve one WSDOC checkpoint per file
         ordinary files: ingestPages -> chunk -> Titan -> Aurora -> pages S3
         unreadable/oversized:
           register Aurora doc + dedicated job mapping
           HeadObject validates signed checksum + byte size without reading content
           InvokeDataAutomationAsync(clientToken, EventBridge=true)
           return status=saving; browser may close
         aggregate parent from child checkpoints
         retrying the same browser attempt reuses requestId + document hashes

ASYNC COMPLETION
  BDA best-effort event -> EventBridge input transform
    {version, invocationArn, outcome, correlationId} -> SQS
  bounded Lambda -> exact job alias Get -> owner mapping Get
    -> GetDataAutomationStatus -> owned BDA output -> bdaToCanonical
    -> S3 kb/pages/<sub>/<docId>.json -> atomic chunk replacement
    -> child ready -> parent aggregate -> job ready
  schedule -> StatusUpdated stale jobs
    queued without ARN -> repeat the deterministic BDA start and attach its alias
    converting/embedding -> GetDataAutomationStatus
      -> enqueue the same compact event (covers missed service events)

RELOAD WORKSPACE
  Library "Open" -> sessionStorage[kb:reloadWorkspace]=itemId -> navigate /docs
  SummarizeView mount -> reloadWorkspace(itemId)
    getWorkspaceFn -> docs; per doc getWorkspacePagesFn -> pages (S3)
    build PileFile/PilePage -> ingestPages -> local BM25 index + reader (instant)
  (KB chunks already in Aurora for server hybrid search)

SEARCH
  searchKb(sub, {workspaceId, surface, query})
    Titan embed query -> kb.hybrid_search (pgvector kNN + BM25 RRF, RLS-scoped)
    -> pre-truncate -> cohere.rerank-v3-5:0 -> top-K passages

ASK (saved Working Set)
  browser pile with a complete savedWorkspace binding
    -> POST /api/kb/ask { itemId, query, docIds }
         getWorkspace (consistent, owner-checked, status=ready)
         searchKb (or reuse follow-up sourceChunkIds)
         fetch_chunks -> existing pile writer SSE
  unsaved / mutated piles stay on /api/pile/ask with local BM25 pages
```

## Security & isolation

- Tenant key = verified Cognito `sub` (`getUserFromRequest` / `requireAuth`), never
  client-supplied.
- FORCE RLS + transaction-local `app.user` GUC on every Aurora call.
- Per-workspace `kbWorkspaceId` partitions chunks within a user.
- S3 SSE-KMS at rest; pages/bytes keys namespaced by `sub`; ownership re-checked on
  read. BDA output is restricted to
  `kb/bda-output/<sub>/<docId>/`. Aurora KMS + IAM DB auth; no static keys.
- Async PUT URLs sign `x-amz-checksum-sha256`; registration and queued
  reconciliation verify the stored checksum and `ContentLength` with
  `HeadObject` before BDA starts. Object bodies are not read or logged.
- The dedicated job row intentionally contains the exact `ownerSub` needed for
  FORCE-RLS access plus hashes and owned coordinates, but no file name or
  document/page text. EventBridge transforms, SQS/DLQ payloads, logs, and
  metrics contain no owner identity, file name, or document text. Terminal
  failures use bounded predefined summaries rather than raw service errors.
- An external async-ingest CMK is accepted only as a producer contract. Its key
  policy must already grant the regional Logs principal and all three exact
  EventBridge rules, including reconciliation DLQ delivery; otherwise the
  stack-generated retained CMK is required.
- Least-privilege app IAM policy (`sw-kb-kb-app-access`): `rds-data:*` on the cluster
  - `secretsmanager:GetSecretValue` on the `kb_app` secret only.
