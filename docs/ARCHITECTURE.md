# SeegerWeissAI — Architecture Map

Whole-app map for the Seeger Weiss litigation-intelligence platform. Concise by
design: it orients you to the surfaces, data stores, and serving topology, then
points at the deeper references. Verify `file:line` against the code before
relying on any specific — the code is the source of truth.

Last updated: 2026-09-18.

## What it is

A TanStack Start (React) application: research, discovery/document analysis,
in-app Office editors, and multi-step workflows for the firm. Single-tenant to
Seeger Weiss, runs on the firm's own AWS account `475976462949` in `us-east-1`,
Bedrock for all inference. HIPAA discipline: synthetic data only, no PHI in
logs/commits; no cost/token figures in the product UI.

## Serving topology

Browser → CloudFront (+ WAF) → API Gateway → one Lambda running the app via the
Lambda Web Adapter (LWA) with response streaming (SSE for chat/research/ask).
CloudFront enforces a ~120s origin timeout, so long jobs run out-of-band (async
Lambda invoke or a background worker), never inline in a request.

- App stack: `litai-testing-runtime` (per-env: testing / staging / prod-in-a-
  separate-account). Deploy with `bun run deploy:testing` (`node
  scripts/deploy-testing.mjs`); it bundles, uploads a versioned artifact, and
  updates the CloudFormation stack.
- Server logic is TanStack **server functions** (`createServerFn` + the
  `requireAuth` middleware), not a separate API tier.

## Auth and tenancy

Microsoft Entra ID (OIDC) federated into an Amazon Cognito user pool; native
Cognito password login is retired, so **Entra is the only IdP** (JIT-provision
users on the Entra side). Every server function derives the principal as the
Cognito `sub`. Per-user isolation is enforced three ways off that `sub`:

- S3: per-user key prefixes (`uploads/{sub}/…`, `kb/pages/{sub}/…`) in the shared
  bucket, re-validated on every read/write.
- Aurora: `FORCE ROW LEVEL SECURITY` with `withPrincipal(sub)` (sets
  `app.user`; default-deny when unset).
- DynamoDB: partition key `USER#{sub}`.

## Nav surfaces (`src/routes/_authenticated/`)

- **Home** (`index`) — intel dashboard / terminal.
- **Research** (`research`) — the research agent chat (SSE `/api/orchestrate`).
- **Discovery** (`docs`) — the 3-tab document workspace: Working Set, Depositions,
  Tabular Review.
- **Library** (`library`) — the user's saved workspaces/files, folder explorer.
- **Matters** (`matters`) — per-matter views over the docket corpus.
- **Office** (`office.*`) — in-app Drafts/Writer, Sheets, Slides editors with AI.
- **Workflows** (`workflows`) — visual multi-step workflow builder + runs.
- Plus `calendar`, `conversations`, `inspector`, `eval`.

## Discovery + Knowledge Base (RAG)

Upload = save + index immediately; there is **no full-text scan** — Ask is
RAG-only, and a set that is still indexing says so rather than scanning every
page. Ingest picks a lane per document:

- **sync** — small text docs embed inline in the save request.
- **text (background)** — larger text docs store their extracted pages and hand
  embedding to the ingest worker (no Bedrock Data Automation); the save returns
  immediately and the user is notified when it's ready.
- **BDA async** — documents with no usable text layer (true scans) go to Bedrock
  Data Automation for OCR, then the worker embeds the result.

Chunks + embeddings live in Aurora Serverless v2 Postgres + pgvector (`sw-kb`,
database `kb`, schema `kb.*`). Retrieval is adaptive per-document hybrid search
(pgvector kNN + BM25, RRF-fused) with Cohere rerank, answered by a streamed
Sonnet-5 writer; partial binding lets a set answer from its ready documents while
the rest finish. Async-ingest infra is its own stack `litai-testing-kb-ingest`
(SQS queue + DLQ, worker + scheduled reconciler Lambdas, a DynamoDB job table,
and EventBridge rules for BDA completion). Design + runbook: `docs/kb/`.

## Office

In-app Word/Sheets/Slides editors with a tiered AI agent (workhorse → reasoning →
synthesis), vision, and templates. Heavy document rendering/conversion runs in a
separate ECS "office engine" service (`litai-testing-office-engine`). The Office
AI's runtime prompt library lives at `src/office/**/prompts/*.md` (loaded at
runtime — these are code, not docs).

## Research agent

Streamed multi-tool agent over `/api/orchestrate` (web search, PubMed, and
`matter_corpus_search` over the docket KBs), with a coverage gate and a
faithfulness/citation verification pass. Full routing/tooling/streaming/prompting
reference: `referenceforagentarchitecture.md`.

## Matters / docket corpus

Followed dockets sync (DocketBird) into S3 and per-matter Amazon Bedrock managed
Knowledge Bases; Aurora `corpus.*` is the metadata sidecar. The app reaches the
docket KBs through the `matter_corpus_search` agent tool (Bedrock `Retrieve`).
This is separate from the Discovery `kb.*` store above.

## Models

All inference is Amazon Bedrock in `us-east-1`, selected by env/config (exact IDs
are volatile — read them from the deployed environment, not from here):

- Discovery RAG writer: Sonnet-5 (`BEDROCK_PILE_WRITER_MODEL`).
- Embeddings: Amazon Titan Text v2. Reranking: Cohere Rerank v3.5.
- Tiered workhorse / reasoning / synthesis models for research, Office, and
  workflows are configured per surface.

## Workflows

Visual builder plus durable execution on SQS + Lambda (stack
`litai-testing-workflows`), gated per environment by `SW_WORKFLOWS_ENABLED`.

## Where to go deeper

- `referenceforagentarchitecture.md` — agent routing, tooling, streaming, prompting.
- `docs/kb/` — KB architecture (`ARCHITECTURE.md`), operations runbook
  (`OPERATIONS.md`), overview.
- `docs/kb-ingest-design.md`, `docs/ingest-contract-v1.md` — ingest/chunking and
  the corpus ETL contract.
- `docs/release/DEV-TO-PROD.md` — deploy runbook. `docs/RESEARCH-ENV.md` —
  research-agent env switches.
- Module `README.md`s under `db/kb/`, `infra/app/`, `src/lib/auth/`,
  `src/routes/`, `services/`.
