# KB Progress Log

Build log for the per-user document KB. Branch `feat/frontier-ux` (unpushed).
Session date: 2026-09-06.

## Phase summary

| Phase | What | Status |
|---|---|---|
| P0 | Analysis, verification, decisions | done |
| P1 | Provision Aurora + schema + Data API seam + pile isolation fix | done |
| P2 | Ingest: canonical + chunking + embed + write seam + sync route | done |
| P3 | Retrieval: hybrid search + Bedrock rerank route | done |
| P4 | Save write-through + confirmation + saved-docs list | done (then reframed by P5) |
| P5a | Saved-workspace backend (record + pages + per-workspace KB) | done |
| P5 | Save-as-workspace client flow (name/folder + byte upload) | done |
| P5b/P5c | Library workspace tabs + one-click reload | done |
| P5e | Idempotent save reservation + cross-store failure recovery | done |
| P5d | Shared workspaces / invite | deferred |
| — | Async BDA lane (SQS/Lambda/EventBridge) | deferred |

## Commits (chronological, all `feat/frontier-ux`)

1. `c6b4193` — Aurora+pgvector migration, ingest design doc, per-user pile isolation fix.
2. `f8ccf81` — RDS Data API seam (`aurora.server.ts`).
3. `895f712` — CloudFormation IaC + Data API result-cap fixes (`hybrid_search` snippet bound, `fetch_chunks`).
4. `28b0916` — Data API migration-apply script (`scripts/kb-apply-migration.mjs`).
5. `b05e222` — canonical format + table-aware chunking (pure, tested).
6. `56f4066` — write seam + converters + embed step (pure, tested).
7. `44e1825` — synchronous ingest route (`/api/kb/ingest`).
8. `d6d9c03` — hybrid search + Bedrock rerank route (`/api/kb/search`).
9. `b1c75d0` — client API helper (`kb-client.ts`).
10. `72cca48` — Save-to-KB write-through in the Working Set.
11. `00880d1` — retry Data API through the scale-to-0 cold start.
12. `e4b3f05` — save confirmation + saved-documents list (`/api/kb/documents`).
13. `a1115fe` — in-app Saved documents panel + search (later removed in P5).
14. `d264588` — saved-workspace backend (`workspace.server.ts` + `workspace.functions.ts`).
15. `7a82357` — save-as-workspace client flow (name/folder + byte upload).
16. `4217e05` — Library workspace tabs + one-click reload; removed SavedDocsPanel.

## Key decisions & rationale

- **Store = Aurora PostgreSQL Serverless v2 + pgvector** (vs OpenSearch Serverless
  or Bedrock KB): AWS-native, in-account, one SQL round-trip for BM25 + vector RRF,
  strong RLS isolation, composes with the existing DynamoDB ownership layer. It is
  the first app-owned relational/vector store (no prior Postgres in prod).
- **Access via the RDS Data API** (vs `pg` + RDS Proxy): HTTP + SigV4, no VPC
  connection pool — fits Serverless v2 and an unsettled app runtime. Trade-off is
  the 1 MiB/64 KB result caps, which the schema is designed around.
- **BDA-first conversion** (design): Amazon Bedrock Data Automation converts all
  PDF/image/DOCX; SheetJS for XLSX; direct parse for TXT. Deletes the Docling/Fargate
  option. (The async BDA lane is deferred; the shipped sync path uses the browser's
  extraction.)
- **Synchronous MVP ingest first**: the browser already extracts page text, so the
  sync route/serverFn ingests it directly — usable now, no SQS/Lambda. The async BDA
  lane handles scanned/oversized later.
- **Titan v2 @ 1024-dim** embeddings computed **at ingest and persisted**; **Bedrock
  `cohere.rerank-v3-5:0`** for the cross-encoder rerank. No external egress.
- **Workspace reframe (P5)**: "save" = a named, reloadable workspace persisting
  chunks + pages + bytes + record, browsed in the Library by surface. Each workspace
  gets its own `kbWorkspaceId` KB partition.
- **Save request idempotency (P5e)**: the browser keeps one UUID for an ambiguous
  save/retry; DynamoDB reserves it before ingest, Aurora document hashes make
  replays non-duplicating, and the record ends in explicit `ready` or `error`.
- **FORCE RLS + transaction-local `app.user` GUC**: correct isolation over the Data
  API (a transaction is one serialized session; a session-level `SET` could leak).

## Verification status

- `tsc --noEmit` clean throughout.
- Test suite: **165/165** passing (`npm test`, node --experimental-strip-types).
  Unit-tested modules: `aurora.server` (helpers + guards), `chunk`, `convert`,
  `embed`, `rerank-parse`, plus the pre-existing pile/agent suites.
- Live probes: `/api/kb/ingest`, `/api/kb/search`, `/api/kb/documents` all return
  `401` unauthenticated (auth gate working); routes auto-registered by the dev server.
- CloudFormation template validates; migration applied over the Data API (28/28
  statements) with the cold-start retry exercised; `kb_app` smoke query returned
  `count=0` (RLS + grants + Data API confirmed).
- UI (Save popover, Library tabs, reload) is tsc-clean and HMR-clean; end-to-end
  click-through is verified by the operator with an authenticated session (the agent
  environment has no Cognito session).

## What a reviewer / successor should know

- The KB is **live** but the cluster is **scale-to-0** in dev — the first
  request after idle takes ~15s (handled by retry, but expect the lag).
- A raw CLI `count` on `kb.*` returns 0 because FORCE RLS hides rows without
  `app.user` set — **verify only through the app routes/serverFns**.
- `KB_CLUSTER_ARN` / `KB_SECRET_ARN` / `KB_DATABASE` must be set in `.env`
  (operator-managed) or the routes return `503`.
- The earlier default-workspace path (`kb-client.ts`, `/api/kb/*` routes,
  `SavedDocsPanel` — now removed) is superseded by the workspace serverFns but
  retained where still valid.

## Remaining / deferred

- Byte download + folder create/upload UI in the Library.
- Search-within-workspace surface in the Library (uses each workspace's `kbWorkspaceId`).
- Depositions / Tabular Review save+reload (schema is surface-aware).
- Async BDA lane (SQS + Lambda + EventBridge, a CloudFormation addition).
- Shared workspaces / invite (P5d).
