# SeegerWeissAI - Codebase Brief

Last updated: 2026-09-06. Audience: whoever picks this project up next, human or agent.
Companion to `docs/HANDOFF.md`. Read HANDOFF first for how to run the app; read this for
what the code actually does and where it is weak.

## Provenance and how much to trust this

Produced by a read-only reconnaissance fan-out: eight subagents each mapped one subsystem
of `lit-ai-extracted/lit-ai-main` (plus the two Word add-in repos and the program docs),
one agent spot-checked every finding rated critical or high, and one agent synthesised the
brief below. No file in the app was modified. Every subagent operated under an explicit
constraint set: no Edit/Write, no mutating shell or AWS commands, no reading `.env`, a
`path:line` anchor required per claim, and the literal label `unverified` required wherever
a claim could not be confirmed.

Trust calibration:

- Claims with a `path:line` anchor were checked by at least one agent against the code.
- The five claims in "Independently verified" below were additionally checked by hand.
- Claims without an anchor are the weakest material here. Treat them as leads.
- The spot-check dropped one finding outright and narrowed three. See Appendix A.
- This reflects the tree as of 2026-09-04. If a claim names a file, function, or model id,
  confirm it still exists before acting on it.

## Independently verified

These were checked directly, outside the agent fan-out, because they are load-bearing:

1. `src/start.ts` now registers `apiAuthMiddleware`, which verifies the Cognito
   session for `/api/*` except `/api/public/*`; public cron/webhook routes retain
   their own shared-secret authentication.
2. `src/routes/api/pile/session.$id.ts:8` returns a pile session by id with no owner
   check. The route is now authenticated globally, but any authenticated firm user
   with an id can still cross-read because the model has no ownership concept.
3. `src/lib/agents/fetch-page.server.ts:104` validates only `^https?:$` and follows
   redirects at `:116`. No private-IP, loopback, or link-local filtering exists.
4. `src/lib/pile/ask-deposition.server.ts:21-22` hardcodes `zai.glm-5` and
   `nvidia.nemotron-super-3-120b` with no env override.
5. Model availability, checked with `aws bedrock list-foundation-models` against
   475976462949 / us-east-1: every model id the runtime names resolves as ON_DEMAND.
   Specifically `zai.glm-5`, `nvidia.nemotron-super-3-120b`, `nvidia.nemotron-nano-12b-v2`,
   `nvidia.nemotron-nano-3-30b`, `google.gemma-3-27b-it`, `amazon.titan-embed-text-v2:0`,
   and `us.anthropic.claude-sonnet-5` as an inference profile.

## Corrections to docs/HANDOFF.md

HANDOFF.md is broadly accurate but wrong on three points. Fix these before acting on it:

1. **"No Marketplace payment instrument, so no third-party/Marketplace models"**
   (HANDOFF section 2) is misleading. Third-party models are available ON_DEMAND in
   us-east-1 and the app already depends on Z.AI, NVIDIA, and Google models in its live
   paths. Nothing is blocked by a payment instrument. Verified item 5 above.
2. **"Delete dead multi-agent code ... `router.server.ts`"** (HANDOFF section 7) is wrong.
   `routeDocument` in `router.server.ts` is live, called from
   `src/lib/agents/summarizer.server.ts:792`. Deleting that file breaks the summariser.
   `orchestrator.server.ts` and `tavily.server.ts` are genuinely unreachable.
3. **The previously open `/api/*` authentication issue is resolved.**
   `apiAuthMiddleware` now gates non-public API routes, and the exposed firm-shared
   server functions named in section 2 now carry per-handler Cognito middleware.

Two model ids in the tree do not resolve, and both are inert: `us.anthropic.claude-haiku-4-5`
appears only in a comment inside dead code, and `google.gemma-4-26b-a4b` appears only in
`src/lib/review/pipeline-core.test.ts:105`, a test that already fails against a retired
`mantle` transport.

---

# SeegerWeissAI Orientation Brief

App root for every `src/...` path below: `C:\Users\fshaher\.claude\projects\unifiedproductionbackend\lit-ai-extracted\lit-ai-main`. Office program artifacts live at `C:\Users\fshaher\.claude\projects\unifiedproductionbackend` and `C:\Users\fshaher\projects\sw-word-agent-review`.

## 1. What the product is, and the five things an attorney can do today

A litigation-intelligence web app (TanStack Start / React 19 / Nitro, bun, port 8080), forked from `nevaubi/lit-ai` and re-platformed onto AWS account 475976462949 in us-east-1. All inference is Bedrock Converse/ConverseStream over SigV4-signed raw HTTPS. Personal data is DynamoDB `sw-dev-app` plus S3 `sw-dev-seegerweissai-475976462949`. Supabase remains as the external corpus/vector database only.

Working attorney capabilities:

1. **Ask a research question and watch it work.** Cited, bottom-line-first answers from live web search, DocketBird, and CourtListener RECAP, with tool steps streaming (`src/routes/api/orchestrate.ts:39`).
2. **Drop a working set of case files and question them.** Up to 120 PDF/Word/Excel/PPT/TXT files, OCR for scanned pages, answers with page cites (`src/lib/use-pile.ts:455`).
3. **Work up a deposition.** Up to 5 transcripts parsed into page:line, producing witness profile, admissions, impeachment, chronology, exhibits, cross-witness contradictions, each pinned to a verbatim quote (`src/lib/pile/ask-deposition.server.ts:70`).
4. **Build a review table.** A spreadsheet over documents: rows are documents, columns are questions, cells are cited answers that can be overridden, verified, and exported to CSV/XLSX with a citations sheet (`src/lib/review/cell-pipeline.server.ts:458`).
5. **Browse a matter and read the home intelligence terminal.** Docket ledger, documents, parties, counsel from the corpus, plus cached mass-tort news/MDL/filing signals and a DocketBird-sourced calendar (`src/lib/workspace.server.ts:99`, `src/routes/_authenticated/index.tsx:30`).

## 2. Architecture in one pass

Browser SPA renders under `src/routes/_authenticated/`. That gate is client-side only: `route.tsx:8` does `ssr:false` plus a browser `fetch("/api/auth/me")`, so it stops navigation, not requests.

Two server surfaces exist and they behave differently.

**Server functions (RPC).** Each protected handler must explicitly attach TanStack
*function* middleware. Chat, library, review, and the firm-shared workspace,
summaries, intel, and calendar reads use `requireAuth`
(`src/lib/auth/require-auth.ts:9`); pipeline administration plus firm-global summary
and upload writes use `requireAdmin`. The middleware re-reads the `sw_id` httpOnly
cookie and verifies the Cognito id_token with `jose` `jwtVerify` against the remote
JWKS, issuer and audience pinned, `token_use==="id"` asserted
(`src/lib/auth/cognito.server.ts:115`). User-owned handlers derive
`principal = context.user.sub` and build `PK=USER#<sub>`, so ownership is structural.

**HTTP file routes (`src/routes/api/*`).** `src/start.ts` registers
`apiAuthMiddleware` as request middleware. It verifies the Cognito session for every
`/api/*` route except `/api/public/*`; the public cron/webhook endpoints continue to
self-authenticate with their shared-secret headers. `requireAuth` remains
function-only and is not the mechanism used for file routes.

From there: Bedrock calls go out through `src/lib/agents/bedrock-sign.server.ts:43` (SigV4, `@smithy/signature-v4`, default credential chain, no static keys). Web search hops to the AgentCore MCP gateway tool `general___WebSearch`. Persistence splits three ways: personal data to DynamoDB/S3 via the AWS SDK default chain; corpus reads to Supabase PostgREST with a static service key; document text for the pile and review tables stays in the browser (IndexedDB / PileIndex) and is POSTed per request.

**The trust boundary has two layers.** `apiAuthMiddleware` gates non-public HTTP
routes, while each protected server function must attach `requireAuth` or
`requireAdmin`. `/api/public/*` deliberately bypasses the Cognito gate and retains
route-specific shared-secret authentication.

## 3. The four named features

### Matter library

Two unrelated things share the name. `/library` (`src/routes/_authenticated/library.tsx:47`) is the attorney's personal store: chat history, saved outputs, prompts, uploads, keyed by Cognito sub, with no matter linkage at all. The matter-scoped document collection is the Documents tab of the matter workspace (`src/components/matters/MatterWorkspace.tsx:185`), reading `public.corpus_*` bridge views over PostgREST with `CORPUS_SERVICE_KEY` (`src/lib/workspace.server.ts:21`), URL-state paging, and a 30-minute presigned PDF GET (`:265`). Maturity: personal library is owner-scoped; the matter workspace is authenticated but intentionally firm-shared, does 3N+1 PostgREST round trips per navigation (`:104`), and depends on `src/lib/s3.server.ts:41`, which hard-requires static AWS keys. There is no matter-scoped personal library.

### Bulk document upload and analysis ("pile" / Working Set)

The live path is entirely client-side: extension filter and byte cap in `DropPanel.tsx:116`, extraction 4 files at a time (`src/lib/use-pile.ts:457`) via pdfjs/mammoth/office-text, glyph-level line reconstruction for transcripts (`src/lib/pile/pdf-lines.ts:10`), BM25 passage index built in a Web Worker, whole `{session, pages}` blob persisted to IndexedDB (`src/lib/pile/local-store.ts:22`). Server acts as a stateless Bedrock proxy: OCR on Nemotron Nano VL, structure inventory on Haiku 4.5, Ask on Sonnet 5 with per-file Nemotron readers when multi-file. Maturity: the wired path works, but it contradicts the stated AWS persistence model (zero S3/Dynamo references under `src/lib/pile` and `src/routes/api/pile`), OCR triggering is length-only so garbled PACER text layers are never re-read (`use-pile.ts:263`), and two rival backends (server SQLite sessions, Supabase scratch) sit in the same directory.

### Deposition analysis

Transcripts are parsed client-side into page:line `TranscriptLine`s, split into 16-block covering windows, run 8-at-a-time as `cover`, then `synth`, then `cross` (`src/lib/use-deposition.ts:284-400`). Each response is parsed, then `snapQuote` re-anchors every quote to real transcript lines and rewrites the cite, deleting anything unquotable (`src/lib/pile/deposition-analysis.ts:140-202,409-524`), then merged with dedupe on displayCite plus normalized quote. `citeReady` gating suppresses invented page:line numbers when the transcript lacks numbered lines. Maturity: the most rigorous citation discipline in the codebase, but it runs only on `zai.glm-5` with `nvidia.nemotron-super-3-120b` as fallback, hardcoded with no env override and no Claude path (`src/lib/pile/ask-deposition.server.ts:21-22`). If neither model is granted in the account, the whole workbench fails after two denied calls.

### Review tables

`useReviewTable` (`src/lib/review/use-review-table.ts:124`) extracts documents in the browser, OCRs bad pages using the quality-aware `pageNeedsOcr`, ingests into the shared PileIndex, and writes one row per document. Columns run sequentially (one retrieval per column, 16 pages per document), rows fan out 10-wide to `POST /api/review/cell`, which runs extract over Nemotron Nano then Gemma, a deterministic quote-on-page check (`src/lib/review/pipeline-core.ts:241`), an independent verify by the other model family, and Sonnet 5 escalation for low-confidence cells. Grid state, history, and runs persist owner-scoped in DynamoDB. Maturity: the most complete and audit-aware feature (six template packs, override/verify trail with actor email, cite-carrying CSV/XLSX export); its cell endpoint is now covered by the global Cognito API gate, while two incompatible row fingerprint formulas and non-cascading row/column deletes remain.

## 4. Microsoft Office / M365 program

**Inventory.** Surface A is Anthropic's closed-source Claude for Microsoft 365 add-in in Bedrock-direct third-party mode; ownership is config only (`generated/office/manifest.xml`, `deployment-log.md:47`). Identity flows Office SSO Entra token to `AssumeRoleWithWebIdentity` into role `ClaudeBedrockAccess`, then `InvokeModelWithResponseStream`. Config precedence is bootstrap, then Entra extension attributes, then manifest; `bootstrap_url` hits Lambda `ClaudeOfficeBootstrap` (public Function URL, JWT validated in code) which returns MCP servers for `ClaudeOfficeWebSearchGateway` plus an inline citation-check skill. Surface B is the first-party Word task pane at `C:\Users\fshaher\projects\sw-word-agent-review` (React/Office.js plus FastAPI, `server/main.py:986`, `server/entra_auth.py:183`, 11 Word mutation tools in `server/word_tools.py:17`).

**Which add-in is live.** `sw-word-agent-review` is the live line: manifest `1.1.1.0`, git-tracked, adds `entra_auth.py`, carries the Entra SSO resource URI on the Amplify domain. `litigation_claudem365/word-addin` is the same manifest Id at `1.0.9.0` and is untracked, an abandoned working copy. Correction to earlier notes: both manifests still serve the taskpane from `https://localhost:3000`, and `word_tools.py` exists in both. There is no recorded ECS or Amplify deployment anywhere; `deploy/aws/*.json` and `amplify.yml` are specs, and today's distribution is a hand-carried ZIP with a PowerShell sideload against `https://localhost:8000`.

**Identity story and blocker.** Identity is not unified in fact. Entra is authoritative for the Office cohort, IAM Identity Center is a separate plane with no SCIM sync from Entra, and Cognito is in use only for the web app. The single `principal_id` / `firm-ai-api` scope model in `04_UNIFIED_SSO_AND_IDENTITY_MAPPING.md` is written, not built. The Entra blocker is narrower than "blocked": assigned pilot users work today because the enterprise app has Assignment required = Yes. What is actually blocked is widening past the assigned cohort, the Outlook surface, and creating the `firm-ai-api` resource app and `access_as_user` scopes that the production gateway path depends on. Separately, manifest `v1.0.0.15` (restores `bootstrap_url`, therefore AgentCore web search) is still pending admin upload, so production today either lacks the pruned model picker or lacks web search. The 26-skill `firm-legal-skills` library has no consuming Office surface; only citation-check is delivered, inlined by the bootstrap Lambda.

## 5. Unified persistence

| Entity | PK | SK | TTL | Owning domain |
|---|---|---|---|---|
| Conversation | `USER#<sub>` | `CONV#<ulid>` | `ttl` = now + `SW_CHAT_TTL_DAYS` (3d); REMOVEd on Keep | Chat |
| Message | `CONV#<convId>` | `MSG#<ulid>` | inherits conv ttl at write time | Chat |
| Library item | `USER#<sub>` | `ITEM#<ulid>` (GSI1PK `FLD#<sub>#<folder>`) | none | Library |
| Review table / column / row | `USER#<sub>` | `RTBL#<t>` / `RCOL#<t>#<ulid>` / `RROW#<t>#<ulid>` | none | Review |
| Review cell / history / run | `USER#<sub>` | `RCELL#<rowId>~<colId>` / `RHIST#<cellId>#<ulid>` / `RRUN#<t>#<ulid>` | none | Review |
| Upload blob | S3 `sw-dev-seegerweissai-475976462949` | `uploads/<sub>/<itemId>/<name>` | none, lifecycle unverified | Library |
| Working set | IndexedDB `wr-working-set` / `pile` | key `current` = `{session,pages,savedAt}` | none enforced; 4h `expiresAt` carried, not checked | Pile |
| Pile session (server) | `.data/pile.sqlite` kv | `sess:<id>[:pages|:index]` | 4h, swept on access | Pile (dead client-side) |
| Corpus matters/entries/documents/chunks | Supabase `public.corpus_*` | `matter_id`, `document_id`, `chunk_id` | none | Matters, intel, RAG |
| Scratch documents/pages | Supabase `scratch_*` | `document_id`, `page_id` | rolling 3 days | Pile (orphaned client) |
| Research session memory | client `memoryRef` | round-tripped in POST body | tab lifetime | Research agent |

Conflicts reconciled: the two RCELL wordings are the same shape because `rowId`/`columnId` already embed `<tableId>#`; trust `src/lib/review/review.server.ts:33-39`. "Corpus is DynamoDB" is wrong; corpus is Supabase, and DynamoDB is only chat/library/review. Bulk upload genuinely touches neither S3 nor DynamoDB; trust the grep. Review-table `total` is `rows.length * columns.length` and does not inflate after deletes, but `needsReview/notFound/errors/verified/filled` do.

## 6. Risk register

Dropped after spot-check: 1 (the "Supabase scratch subsystem is dead code" finding, since 6 routes do import `scratch.server.ts`). Narrowed: 3 (review stat inflation, Word add-in origin claim, `deployment-log.md` citation).

1. **Resolved: anonymous `/api/*` access.** `apiAuthMiddleware` now verifies
   Cognito sessions for every `/api/*` path except `/api/public/*`, whose cron and
   webhook handlers retain their own shared-secret checks.
2. **Authenticated cross-user read of ingested discovery text.**
   `src/routes/api/pile/session.$id.ts:6` returns a session by id with no owner field
   in the model. The API gate prevents anonymous access but not cross-user access.
   Fix: stamp `owner` on pile sessions and compare against the verified sub.
3. **Resolved: anonymous matter corpus and presigned-PDF server functions.**
   Workspace, summaries, intel, and calendar firm reads now use `requireAuth`.
4. **Admin-only arbitrary-prefix write into the shared matters bucket.**
   `src/lib/workspace.server.ts:272-287` still interpolates caller-supplied `slug`
   into the S3 key, but the unused `getUploadUrls` function now requires
   `requireAdmin`. Resolve the slug via a matter lookup before activating callers.
5. **Service-role Supabase key hand-carried between laptops.** `sw-word-agent-review/START-HERE.txt:4-8`. Fix: rotate the key, ship config from Secrets Manager only, stop distributing `.env` in the ZIP.
6. **Authenticated SSRF via `fetch_page`.** `src/lib/agents/fetch-page.server.ts:104` accepts any `http(s)` URL, `redirect:"follow"` at `:116`, no host/IP filter, and the URL can come from previously fetched page content. The API gate removes anonymous reachability but not the SSRF. Fix: resolve and block RFC1918/loopback/link-local, deny redirects off the allowed host set, cap body bytes during read.
7. **Session cookie may ship without `Secure`.** `cognito.server.ts:23` derives `SECURE` from `COGNITO_REDIRECT_URI`, which defaults to `http://localhost:8080/auth/callback`; pool id, client id, and URIs are hardcoded `??` fallbacks at `:11-16`. Fix: fail closed on missing env, force `Secure` unless an explicit dev flag is set.
8. **Un-migrated third-party LLM egress for docket content.** `src/lib/intel-analyze.server.ts:8` posts to `ai.gateway.lovable.dev` with `LOVABLE_API_KEY`. Fix: repoint briefings at Bedrock Converse and delete the key.
9. **Cron jobs target the wrong origin.** `supabase/corpus/calendar-sync-cron.sql:23` and `supabase/migrations/20260828121115_*.sql:8` POST to a `lovable.app` preview host. Fix: repoint the vault secrets at the AWS origin and assert on the next run's stats row.
10. **Deposition workbench has a single-vendor dependency.** `ask-deposition.server.ts:21-22`, hardcoded. Fix: add `BEDROCK_DEPO_MODEL` with a Sonnet 5 fallback.
11. **Cite verification over-reports.** `src/lib/pile/cite-trust.ts:109,126`: a quote-free claim scores `packed` and `verified` counts everything not `none`, so a quote-free answer reads 100 percent verified. Fix: treat missing quotes as unverified and surface them as failures.
12. **Review-table data integrity.** `review.server.ts:215,252` delete only the row/column item, leaving `RCELL#`/`RHIST#` orphans that reload into stats; `use-review-table.ts:329` vs `:448` produce two fingerprints for the same document, duplicating rows and busting `cellCacheKey` (`types.ts:168`). Fix: cascade child deletes as `:154` already does for tables, and pick one fingerprint formula.
13. **Static keys in the presigner.** `src/lib/s3.server.ts:41-44` throws without `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Fix: migrate the matters bucket to the AWS bucket and delete this module.
14. **First-party Word backend accepts any origin and has auth bypasses.** `deploy/aws/task-definition.json:26` sets `ALLOWED_ORIGINS=*`; `server/entra_auth.py:176,183` has `TESTING` and `X-Addin-Token` paths. Fix: pin origins to the Amplify domain and gate the bypasses behind a non-production build.

## 7. Dead or stubbed, and what deleting it breaks

- **Legacy research pipeline.** `src/lib/agents/orchestrator.server.ts:333` (`runOrchestration`) and `tavily.server.ts` have no runtime callers; the two importers use `import type` only. Roughly 1400 lines plus `TAVILY_API_KEY`/`RESEARCH_ENGINE` in this path. Deleting breaks nothing, but keep `router.server.ts`: `routeDocument` is live at `summarizer.server.ts:792`.
- **Server-persisted pile sessions.** `src/lib/pile/session.server.ts:69` plus the `/api/pile/session/*` routes, Titan embeddings, and RRF fusion have no client caller. Deleting removes the only hybrid-vector retrieval path for the pile and risk 2 above; keeping it means maintaining a process-local SQLite store that cannot survive multi-instance deploys (`src/lib/pile/store.ts:97`).
- **Supabase scratch workspace.** `scratch-upload.ts` (client driver) is orphaned, but `scratch.server.ts` and 6 routes are wired. The routes are now covered by the Cognito API gate. Deleting the routes removes unused attack surface and the Voyage dependency; nothing in the UI regresses.
- **Auth stubs.** `requireAdmin` (`require-auth.ts:20`) now gates pipeline administration and firm-global summary/upload writes. `refreshTokens` (`cognito.server.ts:89`) still has zero callers while a 30-day refresh cookie is set, and `queryIndexPrefix` has zero callers though GSI1 keys are written on every library item. Deleting the refresh cookie removes an unused long-lived credential; deleting GSI1 writes removes index cost but also the documented folder read path that was never built.
- **Other dead capabilities.** `runHeavyAnalysis` Kimi chain (`cell-pipeline.server.ts:576`), admin-gated `getUploadUrls`, the `/discovery` and `/summarize` redirect shims, `firm-legal-skills` (26 authored skills with no Office consumer), and the `/eval` harness which is live but absent from the sidebar (`src/components/app-shell.tsx:30`). `pipeline-core.test.ts:105` still asserts a `mantle` transport that `pipeline-core.ts:37` no longer returns, so the review test suite fails as committed.

## 8. Open questions only you can answer

1. What ALB, CloudFront, or WAF controls supplement the application-level Cognito
   boundary in the deployed environment? `src/` now gates non-public APIs and the
   firm-shared server functions, but it cannot establish the deployed edge posture.
2. Are `zai.glm-5` and `nvidia.nemotron-super-3-120b` actually granted in Bedrock us-east-1 for 475976462949? If not, the deposition workbench is dead today.
3. Does `sw-dev-app` have GSI1/GSI2 provisioned and TTL enabled on attribute `ttl`, and does the S3 bucket policy deny non-TLS and non-KMS PUTs with a lifecycle on `uploads/`? No IaC was found in scope.
4. Which pile backend is canonical going forward: browser-only, DynamoDB/S3 server sessions, or Supabase scratch? Three designs currently coexist and only one is wired.
5. Is indefinite IndexedDB retention of case documents acceptable under the firm's retention posture, given nothing enforces the 4h `expiresAt` on rehydrate? Same question for full deposition text POSTed per window with no server session.
6. Was manifest `v1.0.0.15` ever uploaded, and is the `sw-word` ECS service or Amplify app `d3hre39rrrc4fx` actually running? Both are unverifiable read-only.
7. Does the first-party Word add-in supersede Anthropic's client or run alongside it? No decision is recorded in `decision-register.md`.
8. Is a Supabase session still established anywhere post-Cognito? If not, the entire WorkspaceRail (pins, watches, saved answers, prompt library) is silently no-oping at `src/lib/research-workspace.ts:58`.
9. Is `REVIEW_TABLES_ENABLED` on in the pilot, and did you mean `/library` or `matters/$slug?tab=documents` by "matter library"? There is no matter-scoped personal library today.

---

# Appendix A - Spot-check of critical and high findings

Every finding the mappers rated critical or high was re-checked against the cited code by an
independent agent whose instruction was to look for claims that are wrong. Verbatim result:

## Spot-check results

1. **fetch_page SSRF** — CONFIRMED. `lit-ai-extracted/lit-ai-main/src/lib/agents/fetch-page.server.ts:104` only checks `^https?:$`; `redirect:"follow"` at :116; grep for localhost/127.0/169.254/RFC1918/allowlist in that file returns zero hits.
2. **/api/pile/* authentication** — RESOLVED 2026-09-06.
   `apiAuthMiddleware` now verifies the Cognito session before these route handlers;
   function-only `requireAuth` is not used for this HTTP surface.
3. **OCR trigger length-only** — CONFIRMED. `src/lib/use-pile.ts:263` filters `p.text.trim().length < OCR_EMPTY_CHARS`; `pageNeedsOcr` (`src/lib/pile/text-quality.ts:33`) has exactly one caller, `src/lib/review/ocr-pages.ts:15`.
4. **Bulk upload never touches S3/DynamoDB** — CONFIRMED. `src/lib/pile/db.server.ts:8` opens `.data/pile.sqlite`; grep `s3|dynamo` over `src/lib/pile` + `src/routes/api/pile` = zero hits.
5. **Scratch subsystem dead** — PARTLY REFUTED. `src/lib/pile/scratch-upload.ts` genuinely has zero importers (client upload path unreachable), but `scratch.server.ts` **is** imported by 7 call sites across the 6 scratch routes (e.g. `src/routes/api/pile/scratch.session.ts:8`). The HTTP endpoints are live and now covered by the global Cognito API gate; only the client driver is orphaned. Voyage key at `src/lib/pile/scratch.server.ts:192,240` confirmed.
6. **Deposition models hardcoded** — CONFIRMED. `src/lib/pile/ask-deposition.server.ts:21-22` (`zai.glm-5`, `nvidia.nemotron-super-3-120b`), fallback loop at :125-146, `continue` on 400/403/404, no env override, no Claude path.
7. **verifyAnswerCites counts quote-free as verified** — CONFIRMED. `src/lib/pile/cite-trust.ts:109` (`quote.length >= 12 ? quoteOnPage : "packed"`), :117, and `verified: cites.filter(c => c.match !== "none")` at :126.
8. **/api/review/cell authentication** — RESOLVED 2026-09-06.
   The handler has no local auth import because `apiAuthMiddleware` now gates it
   before dispatch.
9. **deleteRow/deleteColumn orphan cells** — CONFIRMED with one correction. `src/lib/review/review.server.ts:215` and `:252` delete only the col/row item (contrast `:154`, where table delete fans out over `RCOL#/RROW#/RCELL#/RRUN#/RHIST#`). In `src/lib/review/use-review-table.ts:881-889`, `needsReview/notFound/errors/verified/filled` are over `Object.values(cells)` and do inflate — but `total` is `rows.length * columns.length`, not cell-derived, so `total` is **not** inflated.
10. **Two row fingerprint formulas** — CONFIRMED. `use-review-table.ts:329` `` `${res.name}|${pages.length}|${chars}` `` vs `:448` `` `${f.name}|${f.pageCount}` ``; consumed by `cellCacheKey` at `src/lib/review/types.ts:168`.
11. **Matter serverFns authentication** — RESOLVED 2026-09-06. Firm-shared
    workspace reads now use `requireAuth`; the 30-minute presign remains at
    `src/lib/workspace.server.ts:265`.
12. **getUploadUrls unsanitised slug + no callers** — AUTH PORTION RESOLVED.
    `getUploadUrls` now uses `requireAdmin`. The prefix remains
    `` `${slug}/incoming/${ns}` `` and the function still has no callers.
13. **s3.server.ts hard-requires static keys** — CONFIRMED. `src/lib/s3.server.ts:41-44`: reads `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `throw new Error("Object storage credentials not configured")`.
14. **research-workspace.ts on Supabase auth** — CONFIRMED as written (including its own "runtime unverified" caveat). `src/lib/research-workspace.ts:58-61`: `uid()` = `supabase.auth.getUser()`.
15. **Only /api/auth/me does an auth check** — SUPERSEDED 2026-09-06.
    `apiAuthMiddleware` now authenticates non-public API routes globally.
16. **Pile session readable by id alone** — PARTIALLY RESOLVED. The route now
    requires a Cognito session, but `getPileSession(params.id)` still has no owner
    comparison.
17. **Secure flag derived from redirect URI** — CONFIRMED. `src/lib/auth/cognito.server.ts:15` default `http://localhost:8080/auth/callback`, `:23` `const SECURE = REDIRECT_URI.startsWith("https://")`, applied at `:153` and `:159`.
18. **Cognito config hardcoded as `??` fallbacks** — CONFIRMED. `cognito.server.ts:11-16` (pool `us-east-1_D7NX6OyAR`, client `3ab10qboajkm0vc36lcv59k78m`, domain, localhost redirect/logout).
19. **All API surface open except /api/public/*** — RESOLVED 2026-09-06.
    Non-public APIs require Cognito; `/api/public/*` continues to self-authenticate
    with `X-Ingest-Key`, `X-Cron-Token`, or webhook tokens.
20. **Intel/calendar serverFns unauth** — RESOLVED 2026-09-06. Their handlers now
    attach `requireAuth`.
21. **Page-route auth is client-side** — STILL TRUE, but it is no longer the
    authorization boundary. Non-public APIs and protected server functions now
    enforce authentication server-side.
22. **Briefings still on Lovable gateway** — CONFIRMED. `src/lib/intel-analyze.server.ts:8` `https://ai.gateway.lovable.dev/v1/chat/completions`, model `google/gemini-3.7-flash` (:9), key `LOVABLE_API_KEY` (:135); docket path `src/lib/intel.server.ts:456` `refreshDocketAnalysis` → `analyzeItems` (:471).
23. **pg_cron POSTs to lovable.app host** — CONFIRMED. `supabase/corpus/calendar-sync-cron.sql:23` and `supabase/migrations/20260828121115_….sql:8`, both `https://project--69032d3d-…lovable.app/api/public/...` stored as vault secrets.
24. **Transfer ZIP ships Supabase service key** — CONFIRMED. `C:/Users/fshaher/projects/sw-word-agent-review/START-HERE.txt:4-8`: "THIS PACKAGE IS SENSITIVE … contains the configured Supabase service key and AgentCore web-search endpoint", hand-carried ZIP.
25. **Only one real Word add-in** — CONFIRMED on identity, REFUTED on the differentiator. Both manifests share `Id d77b0ed0-9f8a-4449-9037-2385ac111f0b`; `sw-word-agent-review/manifest.xml:10` is `1.1.1.0`, `litigation_claudem365/word-addin/manifest.xml:10` is `1.0.9.0`; `word-addin/` is untracked (`?? word-addin/`). But **both** manifests point their taskpane/icons at `https://localhost:3000` — the newer one is not on an Amplify origin; its only Amplify reference is the SSO `<Resource>api://main.d3hre39rrrc4fx.amplifyapp.com/…` (manifest.xml:120). Also `word_tools.py` exists in **both** `server/` dirs, so the newer one adds only `entra_auth.py` (and drops `tavily_search.py`).
26. **Nothing verified deployed** — CONFIRMED, with a correction to the citation. `deploy/aws/{task-definition.json,cloudfront-distribution.json}` + `amplify.yml` are specs only; there is **no** `deployment-log.md` anywhere under `sw-word-agent-review` (the one at `unifiedproductionbackend/deployment-log.md` has zero ECS/Amplify/CloudFront hits). Whether the Amplify app `d3hre39rrrc4fx` is actually live is unverifiable read-only.
27. **ALLOWED_ORIGINS=\* plus JWT bypasses** — CONFIRMED. `deploy/aws/task-definition.json:26`; `server/entra_auth.py:176` `TESTING` bypass, `:183` `ALLOW_SHARED_TOKEN_FALLBACK` + `X-Addin-Token`.

## Persistence key shapes

All checked shapes are internally consistent; no key-shape errors found.
- `src/lib/review/review.server.ts:7-13` documents and `:33-39` builds exactly `PK=USER#<principal>`, `RTBL#<t>`, `RCOL#<t>#<ulid>`, `RROW#<t>#<ulid>`, `RCELL#<t>#<rUlid>~<t>#<cUlid>`, `RHIST#<cellId>#<ulid>`, `RRUN#<t>#<ulid>`. The two differently-worded claims (`RCELL#<rowId>~<columnId>` vs the expanded form) are the same shape, since `rowId`/`columnId` already embed `<tableId>#`. History read at `:389` is `scanForward:false, limit 20` as claimed.
- `src/lib/pile/local-store.ts:3-5`: DB `wr-working-set`, store `pile`, key `current`, value `{session, pages, savedAt}` — matches.

## Corrected statements safe to carry forward

- The Supabase scratch subsystem is **half-dead**: `scratch-upload.ts` (client driver) has zero importers, but `scratch.server.ts` and the 6 `/api/pile/scratch*` routes are wired and covered by the global Cognito API gate. Treat it as reachable authenticated attack surface, not dead code.
- Review-table stats: `needsReview / notFound / errors / verified / filled` inflate after a row/column delete; `total` does not (it is `rows.length * columns.length`).
- Both Word add-in manifests share one manifest Id and both still serve the taskpane from `https://localhost:3000`. The distinguishing facts are version (1.1.1.0 vs 1.0.9.0), git tracking (`word-addin/` untracked), the added `entra_auth.py`, and the Entra SSO `Resource` URI on the Amplify domain. `word_tools.py` is present in both.
- `sw-word-agent-review` contains no `deployment-log.md`; the ECS/Amplify/CloudFront artifacts are specs with no recorded deployment, and live deployment status cannot be confirmed read-only.
- Line-number nits: `fetch-page.server.ts` `redirect:"follow"` is at :116 (`:104` is the protocol check); `use-review-table.ts` fingerprints are at :329 and :448; `cellCacheKey` starts at :168.

---

# Appendix B - Full findings register

All severities, as reported per domain. The synthesised risk register in section 6 above is the
triaged view of this; this appendix is the raw list so nothing is lost. Auth rows
are updated to the 2026-09-06 boundary so they are not carried forward as current
findings.

| Domain | Severity | Finding | Evidence |
|---|---|---|---|
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | resolved | `apiAuthMiddleware` now verifies Cognito sessions for `/api/*` except `/api/public/*`, whose handlers keep their own shared-secret checks. | `src/start.ts` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | critical | Pile sessions still have no owner field and GET `/api/pile/session/$id` returns by id alone. Anonymous access is closed, but authenticated cross-user access remains possible if an id is known or guessed. | `lit-ai-extracted/lit-ai-main/src/routes/api/pile/session.$id.ts:8` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | resolved | `/api/pile/*` is now covered by `apiAuthMiddleware`; function-only `requireAuth` is not needed on each file route. | `src/start.ts` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | resolved | Non-public API routes now require Cognito through global request middleware; `/api/public/*` retains route-level shared-secret authentication. | `src/start.ts` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | resolved | Firm-shared workspace reads and document presigning now require Cognito `requireAuth` on each server function. | `src/lib/workspace.functions.ts` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | reduced | `getUploadUrls` now requires Cognito `requireAdmin` and still has no callers; caller-supplied `slug` remains unsanitised inside the admin-only path. | `src/lib/workspace.functions.ts; src/lib/workspace.server.ts:279` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | critical | The transfer ZIP for the first-party add-in intentionally ships the Supabase service key and the AgentCore search endpoint inside server/.env and is hand-carried between laptops — a service-role DB credential leaving controlled infrastructure. | `C:/Users/fshaher/projects/sw-word-agent-review/START-HERE.txt:4` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | resolved | POST `/api/review/cell` is covered by `apiAuthMiddleware`. It still has no route-specific rate limit. | `src/start.ts; src/routes/api/review/cell.ts` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | high | The Secure cookie flag is derived from COGNITO_REDIRECT_URI, which defaults to http://localhost:8080/auth/callback; if that env var is not set in a hosted environment the session id_token and the 30-day refresh token are sent without Secure. | `lit-ai-extracted/lit-ai-main/src/lib/auth/cognito.server.ts:23` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | high | Production-capable Cognito pool id, client id, domain, redirect and logout URIs are hardcoded as `??` fallbacks, so a missing-env deploy silently authenticates against the dev pool and localhost redirect instead of failing closed. | `lit-ai-extracted/lit-ai-main/src/lib/auth/cognito.server.ts:11` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | high | The live OCR trigger is length-only (<120 chars) and ignores text quality, so the garbled PACER/scan text layers that text-quality.ts was written to catch are counted as emptyPages but never sent to OCR; pageNeedsOcr is only called from the review-table path. | `lit-ai-extracted/lit-ai-main/src/lib/use-pile.ts:263` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | high | Bulk upload never touches S3 or DynamoDB, contrary to the project's stated AWS persistence model: document text lives in browser memory + IndexedDB, the server-side alternative is a local SQLite kv file, and the scratch alternative is Supabase bytea. Grep for S3/Dynamo across src/lib/pile and src/routes/api/pile returns zero hits. | `lit-ai-extracted/lit-ai-main/src/lib/pile/db.server.ts:8` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | high | The entire Supabase 'scratch' workspace subsystem (scratch.server.ts, scratch-upload.ts, 6 routes, Docling python worker contract) has zero importers in src — scratch-upload.ts is imported nowhere, so this upload path is unreachable dead code carrying a service-role key and Voyage API dependency. | `lit-ai-extracted/lit-ai-main/src/lib/pile/scratch-upload.ts:68` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | resolved | `getIntelFeed`, `getCorpusSignals`, and `getCorpusCalendar` now attach Cognito `requireAuth`. | `src/lib/intel.functions.ts; src/lib/calendar.functions.ts` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | informational | The page navigation guard remains client-side, but server-side API request middleware and per-handler server-function middleware now provide the authorization boundary. | `src/routes/_authenticated/route.tsx:8; src/start.ts` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | high | AI briefings for intel items and docket entries still go through the upstream Lovable AI gateway on LOVABLE_API_KEY, not Bedrock/SigV4: an un-migrated third-party LLM egress path for docket content in a fork whose stated LLM boundary is Bedrock Converse. | `src/lib/intel-analyze.server.ts:8` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | high | Both pg_cron definitions POST to a hardcoded lovable.app preview host, so on the AWS deployment intel collection and calendar sync fire against the wrong origin unless the vault secret was repointed after apply. | `supabase/corpus/calendar-sync-cron.sql:23; supabase/migrations/20260828121115_dd7c42dd-6e52-4756-9bf3-0db17745c791.sql:8` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | high | lib/s3.server.ts hard-requires static AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and throws otherwise, contradicting the credential-chain-only posture of lib/data/s3.server.ts; the matter PDF viewer breaks the moment static keys are removed. | `src/lib/s3.server.ts:41` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | high | research-workspace.ts (pins, watches, saved answers, prompt library behind WorkspaceRail) authenticates via supabase.auth.getUser(); with auth migrated to Cognito there is no Supabase session, so uid() returns null and every write silently returns null with no user-visible error. Runtime behaviour unverified. | `src/lib/research-workspace.ts:58` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | high | Only ONE of the two Word add-ins is real. sw-word-agent-review (GitHub fshahersw/wordprod, manifest Id d77b0ed0-… v1.1.1.0, Amplify origin + Entra SSO + ECS pipeline) is the live line; litigation_claudem365/word-addin is the SAME manifest Id at v1.0.9.0 still pointing at https://localhost:3000 and is untracked in git (`?? word-addin/`). It is an abandoned working copy, not a second product — the overlap is total (identical server/*.py filenames), the newer one adds entra_auth.py, word_tools.py, deploy/, Dockerfile. | `C:/Users/fshaher/projects/sw-word-agent-review/manifest.xml:10` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | high | Nothing about the first-party add-in is verified deployed: Amplify/ECS/CloudFront exist only as build specs and JSON (amplify.yml, deploy/aws/task-definition.json, deploy/aws/cloudfront-distribution.json) and deployment-log.md never records an ECS or Amplify deployment. Today's distribution mechanism is a ZIP plus PowerShell sideload against https://localhost:8000. | `C:/Users/fshaher/projects/sw-word-agent-review/START-HERE.txt:1` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | high | The ECS task definition sets ALLOWED_ORIGINS=* on the first-party backend, so any origin may call it; the only remaining control is JWT validation, which itself has an ALLOW_SHARED_TOKEN_FALLBACK / X-Addin-Token path and a TESTING=1 total bypass. | `C:/Users/fshaher/projects/sw-word-agent-review/deploy/aws/task-definition.json` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | high | fetch_page is an SSRF primitive: it fetches any model-supplied http(s) URL server-side with redirect:"follow" and no host/IP allow- or block-list (no localhost, RFC1918, or 169.254.169.254 filter), and the URL can be chosen from content of a previously fetched page (indirect prompt injection). | `src/lib/agents/fetch-page.server.ts:104` |
| Retrieval and deposition analysis (src/lib/pile) | high | Deposition analysis runs only on zai.glm-5 with nvidia.nemotron-super-3-120b as fallback — hardcoded, no env override and no Claude/Sonnet-5 path — so if neither third-party model is enabled in account 475976462949 every deposition pass fails after two denied calls. | `src/lib/pile/ask-deposition.server.ts:21-22,125-146` |
| Retrieval and deposition analysis (src/lib/pile) | high | verifyAnswerCites counts a cite as verified when the model omitted a quote: a <12-char claim span is labelled "packed", and `verified` counts everything that is not "none", so a quote-free answer scores 100% verified. | `src/lib/pile/cite-trust.ts:109,117,126` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | high | deleteRow and deleteColumn delete only the row/column item, never that row's or column's RCELL#/RHIST# items, so orphan cells stay in DynamoDB; listCells reloads them into the cells map and stats (total/needsReview/errors/verified) are computed over Object.values(cells), inflating counts after any delete. | `lit-ai-extracted/lit-ai-main/src/lib/review/review.server.ts:252 and :215; src/lib/review/use-review-table.ts:881` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | high | Row fingerprints are computed two different ways, so the same document added by drag-drop and by "use working set" produces two rows and invalidates cell cache keys: addFiles uses `name\|pages\|charCount`, useWorkingSet uses `name\|pageCount`. | `lit-ai-extracted/lit-ai-main/src/lib/review/use-review-table.ts:330 vs :449, consumed by cellCacheKey in src/lib/review/types.ts:169` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | medium | Message items are keyed PK=CONV#<convId> with no principal in the key and no `owner` attribute, so tenant isolation for chat content rests entirely on every caller calling loadConv(principal, convId) first rather than on the key structure. | `lit-ai-extracted/lit-ai-main/src/lib/chat/chat.server.ts:73` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | medium | A 30-day refresh token is stored in a cookie but refreshTokens() has zero callers, so the long-lived credential is exposed for no benefit while sessions still hard-expire at the id_token exp (~1h). | `lit-ai-extracted/lit-ai-main/src/routes/auth.callback.ts:44` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | resolved | All pipeline server functions now use Cognito `requireAdmin`; the overview derives email from `context.user`, and no Supabase auth import remains. | `src/lib/pipeline.functions.ts` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | medium | The server-persisted pile session (session.server.ts + /api/pile/session/$id/{ingest,ocr,embed,search,structure,ask}) has no client caller; nothing in src fetches /api/pile/session, so the Titan-embedding + RRF hybrid path and its SQLite store are unexercised by the app. | `lit-ai-extracted/lit-ai-main/src/lib/pile/session.server.ts:90` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | medium | If the persisted-session path is ever revived it will break on any multi-instance/serverless deploy: the kv store is a process-local SQLite file under process.cwd()/.data and silently degrades to a per-process in-memory Map when node:sqlite is unavailable, so session reads land on the wrong instance. | `lit-ai-extracted/lit-ai-main/src/lib/pile/store.ts:97` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | medium | Corpus project URL and publishable key are committed as dev fallbacks, so a deploy missing VITE_CORPUS_URL/CORPUS_URL silently reads the shared dev corpus instead of failing loudly. | `src/lib/corpus.ts:23` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | medium | Corpus PostgREST filters are built by raw string interpolation of caller-supplied ids (batch id, matter id list, cl_docket_id) without encoding, giving an injectable PostgREST filter surface to anyone holding the ingest key. | `src/lib/ingest/store.server.ts:82; src/lib/agents/corpus-v2.server.ts:195` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | medium | listMatters issues 3 count requests per matter on top of the list query, and /matters runs it inside beforeLoad purely to pick the first slug — 3N+1 PostgREST round trips per navigation. | `src/lib/workspace.server.ts:104` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | medium | listItems pages the user's entire ITEM# partition with no Limit and then filters by kind in memory, so every Library tab switch reads all of a user's items. | `src/lib/library/library.server.ts:140` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | medium | Reopened conversations lose their matter scope and agent memory (history.ts hardcodes matter: null, memory: null), so a chat resumed from the Library silently runs unscoped. | `src/lib/chat/history.ts:95` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | medium | Identity is NOT unified in fact. Entra is authoritative for the Office cohort; IAM Identity Center is a separate plane with no SCIM sync from Entra (only an `AWS SSO Admins` group exists); Cognito appears only as an optional broker the docs advise against adding for its own sake. The single principal_id / firm-ai-api scope model in 04_UNIFIED_SSO_AND_IDENTITY_MAPPING.md is written down, not built. | `C:/Users/fshaher/.claude/projects/unifiedproductionbackend/decision-register.md:58` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | medium | The Entra-admin blocker is narrower than the register's "blocked" flag implies: tenant-wide consent on Anthropic's multi-tenant app c2995f31-… was never recorded, but the enterprise app has Assignment required = Yes and assigned pilot users work today. What it actually blocks is widening past the assigned cohort, the Outlook surface (separate Graph consent + manifest-outlook.xml), and creating the firm-ai-api resource app / access_as_user scopes that the whole production-gateway path in 03/04 depends on. | `C:/Users/fshaher/.claude/projects/unifiedproductionbackend/decision-register.md:54` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | medium | Manifest v1.0.0.15 — the one that restores bootstrap_url and therefore AgentCore web search — is still pending upload by the M365 admin, so the live add-in is v1.0.0.12/14 and production today either lacks the pruned model picker or lacks web search. | `C:/Users/fshaher/.claude/projects/unifiedproductionbackend/deployment-log.md:151` |
| Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper | medium | The 26-skill firm-legal-skills library is fully authored but unreachable from Office: Skills are "coming soon" in third-party mode and only citation-check is actually delivered, inlined by the bootstrap Lambda. Built inventory with no consuming surface. | `C:/Users/fshaher/.claude/projects/unifiedproductionbackend/generated/office-skills/firm-legal-skills/skills` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | medium | orchestrator.server.ts and tavily.server.ts are unreachable at runtime: runOrchestration (orchestrator.server.ts:333) has zero callers, the only two importers of the module (research-agent.server.ts:9, routes/api/orchestrate.ts:3) use `import type` for Emit/OrchestrateInput/HistoryTurn only, and tavily's runTavilyAngle/tavilyEngineEnabled are imported solely by orchestrator.server.ts:60 — so ~1400 lines plus TAVILY_API_KEY/RESEARCH_ENGINE are dead. router.server.ts is NOT dead: routeDocument is called by summarizer.server.ts:792, which routes/api/summarize.ts uses. | `src/lib/agents/orchestrator.server.ts:333` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | medium | fetch_page reads the entire response body with res.text() before truncating to maxChars, so a large or slow-drip body can exhaust server memory within the 25s window. | `src/lib/agents/fetch-page.server.ts:135` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | medium | Every tool call is emitted as two `tool_call` SSE events (once in onToolUse, once after execute with hits) and the client reducer appends unconditionally, so each tool appears twice in the UI timeline. | `src/lib/agents/research-agent.server.ts:132` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | medium | researchAgentPrompt still tells the model "You do NOT write the final client answer — a separate writer composes it from your digest", but the merged synthesis turn makes the same model write the answer; the prompt then contradicts itself lower down under WRITING THE ANSWER. | `src/lib/agents/prompts.ts:249` |
| Retrieval and deposition analysis (src/lib/pile) | medium | Generic Q&A never blocks hallucinated cites — unverified [Sn] are only rendered as an "N cites could not be matched" note while the answer text stands, unlike the deposition path which hard-deletes unquotable findings. | `src/components/summarize/ResultsPane.tsx:199-201 vs src/lib/pile/deposition-analysis.ts:409-424` |
| Retrieval and deposition analysis (src/lib/pile) | medium | mergeDepAnalysis drops, rather than keeps, findings with neither quote nor cite: the comment says "always keep" but `continue` skips the push, so summary-only findings from synth/cross passes are silently discarded. | `src/lib/pile/deposition-analysis.ts:435` |
| Retrieval and deposition analysis (src/lib/pile) | medium | bm25 removeDoc tombstones a doc and fixes N/totalDl but never decrements index.df, so after OCR re-indexing (which removes every chunk of a page then re-adds) df is permanently inflated — skewing idf and pushing terms past the 0.6 COMMON_DF_RATIO prune threshold. | `src/lib/pile/bm25.ts:73-80; src/lib/pile/pile-index.ts:131-139` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | medium | pipeline-core.test.ts asserts transportFor() returns "mantle" for gemma and kimi, but transportFor was hard-coded to always return "converse" during the AWS port, so the review unit test suite fails as committed. | `lit-ai-extracted/lit-ai-main/src/lib/review/pipeline-core.test.ts:105 vs src/lib/review/pipeline-core.ts:37` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | medium | runHeavyAnalysis (Kimi K2.5 HEAVY_CHAIN for cross-document insights / prompt rewriting) has no callers anywhere in src; MODELS.nemotronSuper is likewise referenced only by tests. Dead capability described as live in the module header. | `lit-ai-extracted/lit-ai-main/src/lib/review/cell-pipeline.server.ts:576 (grep for callers returns only the definition)` |
| Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai) | low | GSI1PK/GSI1SK are written on every library item and queryIndexPrefix supports GSI1/GSI2, but nothing in src ever queries either index — write cost and index capacity for dead code, and the documented folder-contents read path does not exist. | `lit-ai-extracted/lit-ai-main/src/lib/data/dynamo.server.ts:66` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | low | Ask failure messages still name the retired static bearer token ("AWS_BEARER_TOKEN_BEDROCK is not configured") although bedrockEnabled() now only checks the SigV4 credential chain — misleading during on-call triage. | `lit-ai-extracted/lit-ai-main/src/lib/pile/ask.server.ts:39` |
| Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR | low | MAX_BYTES is enforced twice with different meanings: extractFile treats 150 MB as a per-file cap while DropPanel treats it as a cumulative pile cap, so files admitted by one check can be rejected by the other. | `lit-ai-extracted/lit-ai-main/src/lib/extract-text.ts:60` |
| Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell | low | Navigation is inconsistent with the route set: /discovery and /summarize are redirect-only shims to /docs, and the live /eval harness is absent from the sidebar so it is reachable only by typing the URL. | `src/routes/_authenticated/discovery.tsx:9; src/components/app-shell.tsx:30` |
| Matters / workspaces / document Library / chat history (SeegerWeissAI) | low | ItemKind allows "review" and "workspace" but the Library page only renders output/prompt/file tabs, so items of those kinds are written but unreachable in the UI. | `src/routes/_authenticated/library.tsx:47` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | low | The 40s RESEARCH_DEADLINE_MS is only checked at the top of each step, and the final synthesis turn (4000 maxTokens) runs after the deadline regardless, so wall-clock can far exceed 40s. | `src/lib/agents/bedrock-stream-tools.server.ts:241` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | low | Stale operator-facing error text: categorySearch reports "search is not configured (SEARCH_AWS_ACCESS_KEY_ID / SEARCH_AWS_SECRET_ACCESS_KEY missing)" although agentCoreConfigured() now always returns true and those env vars were removed with the SigV4 migration — the branch is unreachable and misleading. | `src/lib/agents/tools.server.ts:366` |
| Retrieval and deposition analysis (src/lib/pile) | low | Both writers gate on bedrockEnabled() (SigV4 credential chain) but throw "AWS_BEARER_TOKEN_BEDROCK is not configured" — leftover from the pre-SigV4 bearer-token era and actively misleading during an auth failure. | `src/lib/pile/ask.server.ts:39; src/lib/pile/ask-deposition.server.ts:39` |
| Retrieval and deposition analysis (src/lib/pile) | low | CiteReport.filesTotal is always set equal to filesRead server-side and only corrected in one UI caller, so any other consumer reading filesTotal gets a meaningless "N of N documents" figure. | `src/lib/pile/cite-trust.ts:129-131; src/lib/use-pile.ts:1057` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | low | Comments and the legacy fallback path still describe Claude/Fireworks as the extractor, but with REVIEW_PIPELINE_ENABLED=true cell.server.ts is unreachable; a reader tuning "the review model" will edit the wrong file. | `lit-ai-extracted/lit-ai-main/src/routes/api/review/cell.ts:72 gates it; src/lib/review/cell.server.ts:19` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | low | pageBudget is decremented inside a mapPool of concurrency 3, so concurrent extractions read a stale budget and a batch can exceed MAX_PAGES. | `lit-ai-extracted/lit-ai-main/src/lib/review/use-review-table.ts:293 and :301` |
| Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools | informational | updateMemory (an extra Bedrock call) is awaited after emit("done") but before the SSE controller closes, holding the connection open past the visible answer. | `src/lib/agents/research-agent.server.ts:189` |
| Retrieval and deposition analysis (src/lib/pile) | informational | hybridRerankHits issues up to 33 Titan calls (query + 32 snippets, 6 concurrent) plus one Haiku call per rerank, and re-implements the same 1/(60+rank) RRF already present in hybridSearchPile — duplicated logic on a latency-sensitive path. | `src/lib/pile/hybrid-rerank.server.ts:18-44 vs src/lib/pile/session.server.ts:93-104` |
| Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI | informational | runCells accepts an onlyFailed option (retry just error cells) that no UI surface passes; only default / columnIds / rowIds / force are wired. | `lit-ai-extracted/lit-ai-main/src/lib/review/use-review-table.ts:600; callers at src/components/docs/review/ReviewTablesTab.tsx:325,417,419,466` |


---

# Appendix C - Capability inventory by domain

Status values come from the mapping agents. `live` means an agent grepped for callers of the
exported symbol and found at least one. `unverified` means it could not be confirmed either way.


## Research agent: SSE streaming tool loop, Bedrock ConverseStream transport, external research tools

- SSE research endpoint [live] src/routes/api/orchestrate.ts:39
- Streaming tool loop + merged synthesis [live] src/lib/agents/bedrock-stream-tools.server.ts:205
- Tool call budget + deadline [live] src/lib/agents/bedrock-stream-tools.server.ts:232
- Prompt caching [live] src/lib/agents/bedrock-stream-tools.server.ts:76
- SigV4 Bedrock/AgentCore transport [live] src/lib/agents/bedrock-sign.server.ts:43
- Web search (8 tools) [live] src/lib/agents/tools.server.ts:484
- CourtListener RECAP (3 tools) [live] src/lib/agents/research-tools.server.ts:117
- DocketBird docket tools (7) [live] src/lib/agents/tools.server.ts:325
- fetch_page [live] src/lib/agents/fetch-page.server.ts:94
- Legacy orchestrator/router/tavily pipeline [dead] src/lib/agents/orchestrator.server.ts:333

## Bulk document upload and analysis ("pile" / Working Set): session model, storage, ingest, OCR

- Client-side bulk extract + BM25 index (the live path) [live] lit-ai-extracted/lit-ai-main/src/lib/use-pile.ts:455
- Vision OCR for scanned pages [live] lit-ai-extracted/lit-ai-main/src/lib/pile/vl-ocr.server.ts:11
- Ask / analyze over the pile [live] lit-ai-extracted/lit-ai-main/src/lib/pile/ask.server.ts:222
- Canned analysis jobs [live] lit-ai-extracted/lit-ai-main/src/lib/pile/jobs.ts:10
- Structure rail inventory [live] lit-ai-extracted/lit-ai-main/src/lib/pile/structure.server.ts:6
- Server-persisted pile session [dead] lit-ai-extracted/lit-ai-main/src/lib/pile/session.server.ts:69
- Supabase "scratch" streamed-upload workspace [dead] lit-ai-extracted/lit-ai-main/src/lib/pile/scratch.server.ts:106
- Transcript parsing / page:line cites [live] lit-ai-extracted/lit-ai-main/src/lib/pile/transcript.ts:327

## Retrieval and deposition analysis (src/lib/pile)

- Deposition multi-pass analysis [live] src/lib/pile/ask-deposition.server.ts:70-111
- page:line cite enforcement (depositions) [live] src/lib/pile/deposition-analysis.ts:140-202,409-524
- citeReady gating [live] src/lib/pile/ask-deposition.server.ts:100-102; src/lib/pile/transcript.ts:282
- Hybrid BM25+Titan retrieval with RRF [live] src/lib/pile/session.server.ts:78-105
- LLM rerank with strict id parsing [live] src/lib/pile/rerank.server.ts:35-46; src/lib/pile/retrieve.ts:105
- Generic Q&A cite verification ([Sn]) [partial] src/lib/pile/cite-trust.ts:85-141; src/lib/use-pile.ts:1053
- Cross-file fan-out/fan-in Ask [live] src/lib/pile/ask.server.ts:222-368
- Deposition merge/dedupe across windows [live] src/lib/pile/deposition-analysis.ts:427-478
- Starter question suggestions [live] src/lib/pile/suggest-questions.ts:10-38
- Markdown export of the workup [live] src/lib/pile/deposition-analysis.ts:591-642

## Review tables (spreadsheet-over-documents extraction) in SeegerWeissAI

- Cell extraction pipeline (extract -> quote check -> verify -> escalate) [live] lit-ai-extracted/lit-ai-main/src/lib/review/cell-pipeline.server.ts:458
- Deterministic citation verification [live] lit-ai-extracted/lit-ai-main/src/lib/review/pipeline-core.ts:241
- Cell state machine [live] lit-ai-extracted/lit-ai-main/src/lib/review/types.ts:80, cell-pipeline.server.ts:274, review.server.ts:344
- Cache-key run skipping and column versioning [live] lit-ai-extracted/lit-ai-main/src/lib/review/review.server.ts:199
- Concurrency and partial-failure handling [live] lit-ai-extracted/lit-ai-main/src/lib/review/use-review-table.ts:694
- Six built-in column template packs [live] lit-ai-extracted/lit-ai-main/src/lib/review/templates.ts:25
- "Test on 10" column sampling [live] lit-ai-extracted/lit-ai-main/src/lib/review/use-review-table.ts:813
- Export with citations [live] lit-ai-extracted/lit-ai-main/src/lib/review/export.ts:55
- Audit trail and run history [live] lit-ai-extracted/lit-ai-main/src/lib/review/review.server.ts:320
- Heavy cross-table synthesis (Kimi K2.5) [dead] lit-ai-extracted/lit-ai-main/src/lib/review/cell-pipeline.server.ts:576

## Matters / workspaces / document Library / chat history (SeegerWeissAI)

- Matter list + workspace header [live] lib/workspace.server.ts:99
- Docket ledger + documents tables [live] lib/workspace.server.ts:170
- Matter PDF viewer [live] lib/workspace.server.ts:256
- Personal Library (4 tabs) [live] src/routes/_authenticated/library.tsx:47
- Presigned upload/download of library files [live] lib/library/library.server.ts:81
- Chat history with 3-day TTL and Keep [live] lib/chat/chat.server.ts:123
- Save an answer to the Library [live] src/components/chat/AnswerActions.tsx:96
- Matter-scoped upload to corpus bucket [dead] lib/workspace.functions.ts:57
- Research workspace rail (pins, watches, prompts, saved answers) [partial] lib/research-workspace.ts:58
- /conversations route [live] src/routes/_authenticated/conversations.tsx:6

## Auth boundary (Cognito OIDC) + DynamoDB/S3 data layer, SeegerWeissAI (TanStack Start fork of lit-ai)

- Cognito authorization-code + PKCE login [live] lit-ai-extracted/lit-ai-main/src/routes/auth.login.ts:9
- JWKS-backed id_token verification [live] lit-ai-extracted/lit-ai-main/src/lib/auth/cognito.server.ts:115
- Non-public API request middleware [live] src/start.ts
- requireAuth serverFn middleware [live] lit-ai-extracted/lit-ai-main/src/lib/auth/require-auth.ts:9
- requireAdmin middleware [live] lit-ai-extracted/lit-ai-main/src/lib/auth/require-auth.ts:20
- Silent token refresh [dead] lit-ai-extracted/lit-ai-main/src/lib/auth/cognito.server.ts:89
- Owner-scoped single-table CRUD [live] lit-ai-extracted/lit-ai-main/src/lib/data/dynamo.server.ts:32
- GSI query helper [dead] lit-ai-extracted/lit-ai-main/src/lib/data/dynamo.server.ts:66
- Direct-to-S3 presigned upload/download [live] lit-ai-extracted/lit-ai-main/src/lib/data/s3.server.ts:31
- Chat TTL with save-to-persist [live] lit-ai-extracted/lit-ai-main/src/lib/chat/chat.server.ts:123
- Local-only user profile [live] lit-ai-extracted/lit-ai-main/src/lib/local-profile.ts:11

## Intel + docket watch, batch ingest, summarize/discovery, calendar, eval, app shell

- Intel terminal (home) [live] src/routes/_authenticated/index.tsx:30
- Scheduled intel collection [live] src/lib/intel-collect.server.ts:411
- Docket watch webhooks [live] src/lib/docketwatch.server.ts:76
- Batch document ingest contract v1.0 [live] src/routes/api/public/ingest/batches.ts:10
- Discovery workspace (/docs) [live] src/components/docs/DocsWorkspace.tsx:26
- Hybrid RAG retrieval [live] src/lib/rag.server.ts:157
- Corpus v2 agent readers [live] src/lib/agents/corpus-v2.server.ts:90
- Calendar sync [live] src/lib/calendar.server.ts:93
- Eval harness (/eval) [live] src/lib/eval-runner.ts:82
- /discovery and /summarize routes [dead] src/routes/_authenticated/discovery.tsx:9

## Microsoft Office / M365 program: Claude for M365 add-in, two Word add-ins, firm skills library, dictation helper

- Claude for M365 Bedrock-direct add-in (Anthropic's client) [live] C:/Users/fshaher/.claude/projects/unifiedproductionbackend/generated/office/manifest.xml:1
- Office web search via AgentCore MCP (JWT gateway) [partial] C:/Users/fshaher/.claude/projects/unifiedproductionbackend/deployment-log.md:95
- First-party SeegerWeiss Word add-in (research + redline) [partial] C:/Users/fshaher/projects/sw-word-agent-review/server/main.py:986
- Agentic Word tool loop [live] C:/Users/fshaher/projects/sw-word-agent-review/server/word_tools.py:17
- Entra SSO per-user auth on the first-party backend [live] C:/Users/fshaher/projects/sw-word-agent-review/server/entra_auth.py:183
- firm-legal-skills library (26 skills) [dead] C:/Users/fshaher/.claude/projects/unifiedproductionbackend/generated/office-skills/firm-legal-skills/skills
- Firm dictation helper (.NET tray app) [unverified] C:/Users/fshaher/.claude/projects/unifiedproductionbackend/dictation-helper-dotnet/README.md:1
- legal-analyst AgentCore sub-agent [unverified] C:/Users/fshaher/projects/litigation_claudem365/sub-agents/legal-analyst/tool-schema.json
- Firm AI gateway (production inference path) [planned] C:/Users/fshaher/.claude/projects/unifiedproductionbackend/03_CLAUDE_FOR_MICROSOFT_365.md:278


---

# Appendix D - Open questions

Raised by the mapping agents. The consolidated list in section 8 of the brief is the deduplicated
version; this is every question as asked.

- Is the throttle/retry behaviour of streamOneTurn adequate? Unlike bedrock.server's Converse path it has no retry/backoff; a ThrottlingException frame throws BedrockStreamError and the whole loop is abandoned with only an agentError log (research-agent.server.ts:166).
- Should the run-state MemoryKV be swapped for DynamoDB/Redis? It is per-process, so tool caching gives nothing across instances (run-state.server.ts:67 exposes the seam).
- Are the persisted-session and Supabase-scratch backends intended for revival on AWS (DynamoDB/S3) or should both be deleted? Right now they are three competing upload designs in one directory with only the browser one wired.
- Should the live pile switch the OCR trigger from length-only to pageNeedsOcr (as review/ocr-pages.ts already does) so garbled PACER layers are re-read?
- Nothing enforces the 4h session expiry on IndexedDB rehydrate — is indefinite local retention of case documents acceptable under the firm's retention posture?
- Are zai.glm-5 and nvidia.nemotron-super-3-120b actually granted in Bedrock us-east-1 for account 475976462949? If not, the entire deposition workbench is dead and needs repointing at BEDROCK_PILE_WRITER_MODEL (unverified — no AWS calls made).
- Is /api/pile/session/:id/embed ever invoked in the normal Ask flow, or does hybridSearchPile usually fall back to keyword-only because no page has an embedding? (Only the route and embedPile were found; no client trigger verified.)
- Deposition transcripts are parsed in the browser and full testimony text is POSTed per 16-block window to /api/pile/ask with no server session — is that acceptable under the HIPAA discipline, and is anything logging those request bodies?
- Should verifyAnswerCites delete or visibly strike unmatched [Sn] before the answer is exported, to match the deposition path's drop-on-fail behaviour?
- Should deleteRow/deleteColumn cascade-delete RCELL#/RHIST# items, or is orphan retention wanted for audit? Today it is neither cleaned nor filtered.
- Is the Kimi HEAVY_CHAIN path (runHeavyAnalysis) planned work or should it be deleted along with MODELS.nemotronSuper and the mantle transport remnants?
- Which fingerprint scheme is canonical for ReviewRow, `name|pages|chars` or `name|pageCount`? The mismatch silently duplicates rows and forces full re-extraction.
- Which surface did the user mean by "matter library" — matters/$slug?tab=documents (per-matter corpus documents) or /library (personal, un-scoped)? There is currently no matter-scoped personal library at all.
- Is a Supabase session still established anywhere post-Cognito, or is the whole WorkspaceRail (pins/watches/saved answers/prompts) dead in practice?
- Is the `matters` Supabase Storage bucket meant to migrate to the AWS bucket, which would let lib/s3.server.ts and its static keys be deleted?
- Does the deployed sw-dev-app table actually have GSI1/GSI2 and TTL enabled on attribute `ttl`? Only the code side was verifiable here; no IaC or table definition was found in scope.
- Is COGNITO_REDIRECT_URI set (https) in every non-local environment, and is the Cognito app client restricted to those callback URLs?
- Does the S3 bucket policy deny non-TLS and non-KMS PUTs, and is there a lifecycle rule for uploads/? The code relies on bucket-default SSE-KMS.
- Which edge controls (ALB, CloudFront, or WAF) supplement the application-level Cognito gate in production?
- Was the Lovable AI gateway in intel-analyze.server.ts intentionally left un-migrated, or is it an outstanding Bedrock cutover item?
- Which host do the two pg_cron jobs target today: the vault secrets may have been repointed off the committed lovable.app URLs (unverified from the repo).
- Is REVIEW_TABLES_ENABLED on in the pilot, i.e. does the Review tab actually appear for attorneys?
- Is the sw-word ECS service / Amplify app actually running in 475976462949, or are deploy/aws/*.json and amplify.yml unapplied? AWS SSO token was expired at last log, so unverified.
- Was manifest v1.0.0.15 ever uploaded to M365 Integrated apps, and which version is live in the pilot today?
- Is the .NET dictation helper signed and installed on any pilot machine, or still prototype-only? Transcribe retention gates were noted as pending.
- Does the first-party add-in supersede Anthropic's client (per docs/custom-addin-buildout-scope.md's six ceilings) or run alongside it? No decision is recorded in decision-register.md.
