# KB Progress Log

Build log for the per-user document KB. Branch `feat/frontier-ux` (unpushed).
Session date: 2026-09-06.

## Phase summary

| Phase     | What                                                           | Status                            |
| --------- | -------------------------------------------------------------- | --------------------------------- |
| P0        | Analysis, verification, decisions                              | done                              |
| P1        | Provision Aurora + schema + Data API seam + pile isolation fix | done                              |
| P2        | Ingest: canonical + chunking + embed + write seam + sync route | done                              |
| P3        | Retrieval: hybrid search + Bedrock rerank route                | done                              |
| P4        | Save write-through + confirmation + saved-docs list            | done (then reframed by P5)        |
| P5a       | Saved-workspace backend (record + pages + per-workspace KB)    | done                              |
| P5        | Save-as-workspace client flow (name/folder + byte upload)      | done                              |
| P5b/P5c   | Library workspace tabs + one-click reload                      | done                              |
| P5e       | Idempotent save reservation + cross-store failure recovery     | done                              |
| P6        | Bind saved piles to workspaces and route Ask through hybrid KB | done                              |
| P5d       | Shared workspaces / invite                                     | deferred                          |
| async-bda | Async BDA lane (EventBridge/SQS/Lambda + reconciliation)       | implemented locally; not deployed |

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
- **BDA-first conversion**: Amazon Bedrock Data Automation converts
  PDF/image/DOCX; SheetJS for XLSX; direct parse for TXT. Deletes the Docling/Fargate
  option. The async lane now handles unreadable/oversized workspace documents;
  ordinary browser-extracted files remain on the compatible synchronous path.
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
- **Saved Ask stays fail-closed (P6)**: the browser only sends the workspace id
  and selected Aurora `docId`s. Adding or OCR-mutating files drops the binding so
  Ask cannot search a stale saved snapshot while showing new local pages.
- **Exact job correlation, never Aurora discovery:** a dedicated encrypted
  DynamoDB table stores the principal, request/source fingerprints, and owned
  coordinates under a stable token, with an exact alias for the BDA invocation
  ARN/`job_id`. Workers perform exact reads, then
  every Aurora call remains inside `withPrincipal(ownerSub)`.
- **Best-effort event recovery:** exact BDA success/client-error/service-error
  events are transformed to compact full-invocation-ARN EventBridge → SQS
  payloads. A scheduled reconciler restarts stale queued reservations with the
  same token, polls stale invocations, and enqueues the same idempotent event.
- **Per-document workspace checkpoints:** `WSDOC#...` items prevent parallel
  workers from overwriting one manifest. Parent state is aggregated from all
  expected documents.
- **One bounded worker per document:** no Step Functions or chunk-shard fanout
  in this phase. Page, markdown, and chunk ceilings fail closed before the
  Lambda time limit.

## Async-BDA implementation (uncommitted)

- Additive `0002_kb_async_ingest.sql` (including owner-bound keys and client
  file correlation) and ordered migration discovery.
- Pure transition, lane, key, and raw/compact event contracts with deterministic tokens.
- Existing-document atomic chunk replacement and owner-scoped Aurora helpers.
- Conditional job store, BDA EventBridge invocation, completion core, and stale
  reconciliation.
- Workspace child checkpoints, mixed sync/async saves, per-document progress,
  owner-scoped single/batch polling, pending-workspace deletion, browser
  raw-byte SHA-256, and low-quality/scanned async routing.
- Checksum-bound presigned PUTs plus metadata-only S3 checksum/size verification
  before both initial and reconciled BDA starts.
- Thin handlers, reproducible worker ZIP scripts, `kb-ingest.cfn.yaml`, and
  runtime producer contracts.

> **NO DEPLOY / NO MIGRATION:** No AWS API, change set, deployment, artifact
> upload, or migration application is authorized or performed in this phase.

## Verification status

- `tsc --noEmit` clean.
- Full test suite: **231/231 passing**, including transition matrix, signed
  upload integrity, owned key
  validation, duplicate completion, terminal failure repair, stale
  reconciliation, checkpoint aggregation, route compatibility, partial batch
  failures, and IaC invariants.
- All four production CloudFormation templates pass local `cfn-lint`.
- Ordered migration dry-run parses **36 statements across 0001 and 0002** and
  explicitly makes no AWS calls.
- Controlled production application build succeeds with `.env` loading
  explicitly disabled (`LITAI_LAMBDA_BUILD=true`).
- Worker bundle imports and deterministic ZIP packaging succeed with
  `bun --no-env-file`.
- IDE lint diagnostics and `git diff --check` are clean.
- `cfn-guard` is not installed locally, so guard-policy validation was not run.
- Earlier live probes and the applied 0001 migration were prior phases. They
  were not repeated; 0002 and the async infrastructure remain unapplied.

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
- Shared workspaces / invite (P5d).
