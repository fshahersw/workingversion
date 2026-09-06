# KB Architecture

Detailed technical architecture of the per-user document KB. See
[OVERVIEW.md](OVERVIEW.md) for the what/why and [OPERATIONS.md](OPERATIONS.md) for
provisioning/runbook.

## Production stack (AWS-native only)

| Concern | Service | Notes |
|---|---|---|
| Auth / identity | Amazon Cognito (OIDC + PKCE) | principal = verified id-token `sub`; httpOnly `sw_id` cookie |
| Relational + vector | Aurora PostgreSQL Serverless v2 + pgvector | cluster `sw-kb-kb`, private, RDS Data API, FORCE RLS |
| Blobs | Amazon S3 (SSE-KMS) | original bytes + extracted pages; bucket `sw-dev-seegerweissai-475976462949` |
| Metadata / records | DynamoDB single table `sw-dev-app` | library items (incl. `workspace` kind), folders on GSI1 |
| Embeddings | Bedrock Titan Text Embeddings V2 | `amazon.titan-embed-text-v2:0`, 1024-dim, cosine |
| Rerank | Bedrock Rerank | `cohere.rerank-v3-5:0` via `bedrock-agent-runtime` |
| Credentials | SigV4 default chain | SSO in dev, scoped IAM role in prod; no static keys |

Legacy (being retired, NOT used by the KB): Supabase, Voyage, Lovable gateway.

## The four-artifact workspace model

"Saving" a working set persists **four** things so it reloads one-click into a
fully queryable state:

| # | Artifact | Store | Purpose |
|---|---|---|---|
| 1 | Chunks + embeddings | Aurora `kb.chunks` | server-side hybrid search — no re-embed on reload |
| 2 | Extracted pages (`{page,text}[]`) | S3 `kb/pages/<sub>/<docId>.json` | one-click pile rehydrate (instant local search + reader) |
| 3 | Original file bytes | S3 (presigned PUT, best-effort) | the actual document, re-openable/downloadable |
| 4 | Workspace record | DynamoDB library item (`type=workspace`) | Library browse/organize (name, surface, folder, doc manifest, `kbWorkspaceId`) |

Each saved workspace gets its own **`kbWorkspaceId`** (a UUID) so its chunks are a
separate KB partition and searching a reloaded workspace queries only its docs.

## Aurora schema (`db/kb/0001_kb_init.sql`)

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
5. **`ingest.server.ts`** — `ingestCanonicalDoc` / `ingestPages`: insert document
   (status `embedding`) → chunk → embed → insert chunks → status `ready`
   (error-marks on failure).

## Retrieval pipeline

- **`search.server.ts`** — `searchKb`: embed query (Titan) → `kb.hybrid_search`
  (pgvector + BM25 RRF) → **Bedrock rerank** (`cohere.rerank-v3-5:0`) → top-K.
  Degrades gracefully: lexical-only if the embedder fails, fused order if rerank
  fails. Bedrock/Titan imports are lazy so the module is node-testable.
- **`rerank-parse.ts`** — pure parser for the Bedrock Rerank response (identity
  fallback), unit-tested.

## Workspaces (Library integration)

- **`workspace.server.ts`** — `saveWorkspace` (DynamoDB `type=workspace` item with
  surface + folder + doc manifest + `kbWorkspaceId`), `listWorkspaces` (by surface),
  `getWorkspace`, `getWorkspacePages` (S3 → rehydrate, ownership-checked),
  `getWorkspaceDownloadUrl` (bytes), `deleteWorkspace` (cascades S3 pages+bytes),
  `putWorkspacePages` (pages → S3).
- **`workspace.functions.ts`** — `createServerFn` (requireAuth) wrappers:
  `saveWorkspaceFn` (mints `kbWorkspaceId`, ingests each file scoped to it, stores
  pages, writes record), `listWorkspacesFn`, `getWorkspaceFn`,
  `getWorkspacePagesFn`, `deleteWorkspaceFn`.

## Client

- **`src/lib/use-pile.ts`** (the Working Set hook):
  - retains original `File` blobs by name (`filesByNameRef`) so Save can upload bytes;
  - `saveWorkspace(name, folderId)` — uploads bytes (library presigned PUT),
    gathers pages, calls `saveWorkspaceFn`; status in `state.kbSave`;
  - `reloadWorkspace(itemId)` — `getWorkspaceFn` + `getWorkspacePagesFn` per doc →
    build `PileFile`/`PilePage` → `ingestPages` rehydrate;
  - IndexedDB store namespaced by Cognito `sub` (shared-workstation fix).
- **`src/components/summarize/SummarizeView.tsx`** — "Save workspace" name+folder
  popover; reads `sessionStorage["kb:reloadWorkspace"]` on mount to trigger reload.
- **`src/routes/_authenticated/library.tsx`** — Working Sets / Depositions /
  Tabular Review tabs; `WorkspacesList` lists + Open (sessionStorage handoff) + Delete.
- **`src/lib/kb/kb-client.ts`** — `ingestFileToKb` / `searchKbApi` /
  `listKbDocuments` (used by the earlier default-workspace path; retained for a
  future Library search surface).

## API surface

Server functions (`createServerFn`, requireAuth): `saveWorkspaceFn`,
`listWorkspacesFn`, `getWorkspaceFn`, `getWorkspacePagesFn`, `deleteWorkspaceFn`,
plus the library `createUploadFn` (byte presign).

File routes (`createFileRoute`, gated by `apiAuthMiddleware`, principal via
`getUserFromRequest`): `POST /api/kb/ingest`, `POST /api/kb/search`,
`GET /api/kb/documents`. (Superseded by the workspace serverFns for the workspace
flow, but valid and retained.)

## Data-flow summaries

```
SAVE WORKSPACE
  browser (pile pages + File blobs)
    -> presign+PUT bytes to S3 (per file)
    -> saveWorkspaceFn { name, surface, folderId, files:[{fileName,pages,bytesKey,...}] }
         mint kbWorkspaceId
         per file: ingestPages -> chunk -> Titan embed -> Aurora kb.chunks
                   putWorkspacePages -> S3 kb/pages/<sub>/<docId>.json
         saveWorkspace -> DynamoDB workspace item (manifest + kbWorkspaceId)

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
```

## Security & isolation

- Tenant key = verified Cognito `sub` (`getUserFromRequest` / `requireAuth`), never
  client-supplied.
- FORCE RLS + transaction-local `app.user` GUC on every Aurora call.
- Per-workspace `kbWorkspaceId` partitions chunks within a user.
- S3 SSE-KMS at rest; pages/bytes keys namespaced by `sub`; ownership re-checked on
  read. Aurora KMS + IAM DB auth; no static keys. No PHI in logs.
- Least-privilege app IAM policy (`sw-kb-kb-app-access`): `rds-data:*` on the cluster
  + `secretsmanager:GetSecretValue` on the `kb_app` secret only.
