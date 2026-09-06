# SeegerWeissAI — Project Handoff (read this first)

Last updated: 2026-09-06. Author: prior Claude Code session. Audience: a fresh
Claude Code instance (terminal or inside the Claude desktop app) picking this up
cold, and the human driving it (Firas Shaher, AI Solutions Architect, Seeger
Weiss LLP).

This is the single "get up to speed" document. Read it top to bottom, then read
`docs/CODEBASE-BRIEF.md` for what the code actually does subsystem by subsystem
(produced 2026-09-04 by a verified read-only fan-out; it also lists the security
findings and corrects three errors in this file), `docs/ARCHITECTURE.md` for the
technical map, and `docs/MCP-AND-PLUGINS.md` for Claude-app configuration. Deeper
narrative history lives in the user auto-memory (see "Where the rest of the
context lives" below).

---

## 1. What this project is

**SeegerWeissAI** is a litigation-intelligence web app for Seeger Weiss LLP. It
is a fork of the open-source `nevaubi/lit-ai` app, re-platformed onto AWS. The
headline feature is a **research agent**: an attorney asks a litigation question
(docket status, MDL posture, case-management orders, authorities) and the app
runs a tool-using research loop and streams back a cited answer. Secondary
features: a Discovery / "Working Set" summarizer, a table-review pipeline, a
document Library (chat history, saved, uploads, prompts), and S3 uploads.

It is a **pilot**, not yet in production. Data is synthetic. Treat it with HIPAA
discipline anyway: no PHI in logs, commits, or fixtures.

## 2. Stack at a glance

- **Framework:** TanStack Start (React 19) + Nitro server. Server functions via
  `createServerFn(...).middleware([requireAuth]).inputValidator(fn).handler(fn)`;
  SSE routes via `createFileRoute("/api/...")({ server: { handlers: { POST } } })`.
- **Build/runtime:** Vite (dev server on **port 8080**), **bun** as the runner
  (auto-loads `.env` into `process.env` at start).
- **UI:** Tailwind + Radix + lucide-react. Markdown via react-markdown v9;
  diagrams via `mermaid` (lazy, client-only).
- **Auth:** migrating off Lovable to **AWS Cognito + Microsoft Entra SSO**.
  Cognito `user.sub` is the principal. See the `seegerweissai-auth` memory; there
  is a pending Entra-admin blocker. Verify current wiring against
  `requireAuth` in the code before assuming state.
- **Data (AWS):** DynamoDB single table **`sw-dev-app`** (chat, library, ACLs,
  review tables), S3 bucket **`sw-dev-seegerweissai-475976462949`** (uploads,
  presigned PUT/GET), KMS. Account **475976462949**, region **us-east-1**.
- **LLM:** AWS Bedrock (Converse / ConverseStream) over raw HTTPS signed with
  **SigV4** (default credential chain). Primary model **Sonnet 5**
  (`us.anthropic.claude-sonnet-5`). ON_DEMAND only, no Marketplace subscriptions.
  CORRECTED 2026-09-04: this does **not** mean Anthropic-only. Third-party models
  are available ON_DEMAND in us-east-1 and the app already depends on them in live
  paths: `zai.glm-5` and `nvidia.nemotron-super-3-120b` (deposition analysis),
  `nvidia.nemotron-nano-*` and `google.gemma-3-27b-it` (OCR, review-table cells).
  All verified present via `aws bedrock list-foundation-models`.
- **Corpus (external):** a Supabase project is kept ONLY as an external corpus /
  vector DB. It is not the app backend anymore (see "Stale docs" below).

## 3. Where the code runs from, and where memory lives

- **Working directory (the code):**
  `C:\Users\fshaher\.claude\projects\unifiedproductionbackend\lit-ai-extracted\lit-ai-main`
- **Memory-keyed project root:**
  `C:\Users\fshaher\.claude\projects\unifiedproductionbackend`
  The user auto-memory (`MEMORY.md` + the `memory/` folder) auto-loads only when
  the Claude Code project root is this path. The code sits in the
  `lit-ai-extracted\lit-ai-main` subfolder underneath it.

**Consequence for the new instance:** open the project at
`C:\Users\fshaher\.claude\projects\unifiedproductionbackend` so the memory loads,
then work inside `lit-ai-extracted\lit-ai-main`. If you open directly at
`lit-ai-main`, the memory will not auto-load, but this `docs/` set still brings
you fully up to speed.

## 4. How to run it

From the code directory, with the AWS SSO profile logged in
(`aws sso login --profile AdministratorAccess-475976462949` if the session has
expired):

```bash
cd "/c/Users/fshaher/.claude/projects/unifiedproductionbackend/lit-ai-extracted/lit-ai-main"
AWS_PROFILE=AdministratorAccess-475976462949 \
AWS_REGION=us-east-1 \
BEDROCK_REGION=us-east-1 \
SW_DDB_TABLE=sw-dev-app \
SW_S3_BUCKET=sw-dev-seegerweissai-475976462949 \
bun run dev
```

Then open http://localhost:8080.

**Port already in use?** A prior dev server child can hold 8080. Free it:

```bash
netstat -ano | grep LISTENING | grep ":8080"     # find the PID
taskkill //PID <pid> //F                          # kill it (Git Bash slash-flags)
```

**Typecheck (do this after edits; the app has ~0 tsc errors as of handoff):**

```bash
npx --no-install tsc --noEmit -p tsconfig.json
```

**Test scripts** live in `scripts/` (excluded from app tsc) and are run with
`bun run scripts/<name>.ts` with the same env prefix. Useful ones:
`test-bedrock-sigv4.ts`, `test-agentcore-iam.ts`, `test-research-agent.ts`,
`test-stream-loop.ts`, `test-courtlistener.ts`, `test-fetch-page.ts`,
`probe-latency-optimized.ts` (see note in section 7).

## 5. Environment variables (names only; never echo values)

`.env` at the project root holds the secrets. **It is permission-blocked for the
agent on purpose (secrets); do not read it, print it, or commit it.** bun loads
it at `bun run` start, so after adding a var you must restart the dev server.

- **AWS auth:** none as a static key. Bedrock and AgentCore are signed with
  **SigV4 from the default credential chain** (`AWS_PROFILE` in dev, an IAM role
  in prod). The old static `AWS_BEARER_TOKEN_BEDROCK` is **deprecated / killed**
  and must not be reintroduced.
- **Tool creds:** `COURTLISTENER_API_TOKEN` (RECAP archive), `DOCKETBIRD_API_KEY`
  (DocketBird REST).
- **App infra:** `SW_DDB_TABLE` (=`sw-dev-app`), `SW_S3_BUCKET`
  (=`sw-dev-seegerweissai-475976462949`), `AWS_REGION` / `BEDROCK_REGION`
  (=`us-east-1`).
- **Optional overrides:** `BEDROCK_RESEARCH_MODEL`, `AGENTCORE_SEARCH_URL`,
  `AGENTCORE_SEARCH_TOOL`.

## 6. The research agent in one paragraph

`src/routes/api/orchestrate.ts` (SSE) calls `runResearchAgent` in
`src/lib/agents/research-agent.server.ts`. It is a **single strong agent** (Sonnet
5), not a multi-agent router anymore. It runs a **streaming tool loop**
(`streamConverseToolLoop` in `bedrock-stream-tools.server.ts`): the model narrates
one status line per step, emits parallel `tool_use` blocks, tools execute in
parallel under a budget, and after research a **final merged synthesis turn**
streams the answer (no separate writer pass). **Prompt caching** is on: a stable
`cachePoint` on system+tools plus a moving `cachePoint` on the last message, so
the growing tool transcript is read from cache every turn. Tools:
AgentCore web search (IAM gateway `general___WebSearch`), `fetch_page`,
CourtListener RECAP (`recap_search` / `recap_docket` / `recap_read`), DocketBird
REST (`db_*`), and the category `search_*` tools. Full detail in
`docs/ARCHITECTURE.md`.

## 7. Current state (as of 2026-09-04)

**Done and verified:**
- Single-agent research loop live; multi-agent router/sub-agent machinery
  retired (dead code still present, see below).
- SigV4 auth for Bedrock + AgentCore (no static keys/bearer token).
- Web search repointed to the account's real IAM AgentCore gateway.
- CourtListener RECAP + DocketBird REST integrated (REST, not MCP — DocketBird's
  MCP is OAuth-only, unusable headless).
- Writer merged into the streaming loop + incremental message caching; deep
  questions run one continuous stream at ~55-60s.
- UI polish: `ThinkingStream` (single current-step status line, no cursor,
  collapses to "Steps taken" when done), Mermaid diagram rendering, footnote-
  superscript citations, dynamic answer shape, removed the reflexive "verify on
  the docket" closer. Varied the repeated "Research" labels.

**Latency finding (verified this session via `scripts/probe-latency-optimized.ts`):**
Bedrock **Latency-Optimized Inference is NOT supported for Sonnet 5 in
us-east-1** (returns HTTP 400). Standard Sonnet 5 TTFT is ~1.4s per call, so the
model is not the bottleneck; the ~25-30s research portion is mostly **tool
network time**, plus ~16s fixed synthesis generation. We are near the safe
on-demand floor.

**Open / pending:**
- **AUTH BOUNDARY CLOSED 2026-09-06:** `apiAuthMiddleware` now requires a valid
  Cognito session for `/api/*` except `/api/public/*`, whose cron/webhook routes
  retain their own shared-secret authentication. Server functions still require
  per-handler middleware; the firm-shared workspace, summaries, intel, and calendar
  reads now use `requireAuth`, while pipeline administration and firm-global
  summary/upload writes use `requireAdmin`. Pile sessions still lack owner scoping,
  and `fetch_page` still needs private-IP/redirect filtering, but those paths are no
  longer anonymously reachable.
- **Browser smoke test** of the current streaming UX (thinking box, tool chips,
  Mermaid, footnote citations, no reflexive caveat).
- **Per-tool hard timeouts** (proposed, not built): cap each tool call (~8s) so
  one slow RECAP/fetch cannot stall a turn. The one remaining safe latency win.
  Firas was asked to choose (a) add timeouts, (b) A/B a fast tool-loop model
  despite quality/cache risks, or (c) leave latency and move on. Not yet chosen.
- **Delete dead multi-agent code** once the single agent is confirmed in-browser:
  `orchestrator.server.ts` (`runOrchestration` at :333) and `tavily.server.ts` have
  no runtime callers, roughly 1400 lines. NOTE: `research-agent.server.ts` still
  imports the `OrchestrateInput` and `Emit` **types** from `orchestrator.server.ts`
  (see `research-agent.server.ts:9`) — extract those types to a small shared file
  before deleting the file.
  **CORRECTED 2026-09-04: do NOT delete `router.server.ts`.** An earlier version of
  this doc listed it as dead. It is live: `routeDocument` is called from
  `src/lib/agents/summarizer.server.ts:792`. Deleting it breaks the summariser.
- **Auth SSO / Entra federation** blocker: the 10-tool specialized JWT AgentCore
  gateway (`ClaudeOfficeWebSearchGateway`) only accepts Microsoft Entra tokens,
  not our Cognito pool. Needs pending Entra-admin federation. We currently use
  the single IAM gateway instead.

## 8. Non-negotiable working rules (from the user's global CLAUDE.md)

- Terse, direct. No hype, **no em dashes**. Grounded and neutral.
- **Complete outputs only:** full files, no stubs, placeholders, or
  "rest unchanged" elisions.
- Push back on over-engineering and scope creep.
- **Never echo secrets:** the `.env` values, and the deprecated
  `AWS_BEARER_TOKEN_BEDROCK` value in `~/.claude/settings.json`.
- **`aws iam` commands are blocked for the agent** — Firas runs those himself
  (suggest he type `! <command>` in the session so output lands in the chat).
- No Marketplace payment instrument on the AWS account: use first-party /
  ON_DEMAND models only.
- HIPAA discipline: no PHI in logs, commits, or fixtures. Synthetic data only.

## 9. Stale / historical docs (do not trust as current)

- `docs/agent-backend.md` describes the **old** Supabase-hosted multi-agent
  backend (`/orchestrate`, `/quick-ask` edge functions, immigration corpus). That
  architecture was **replaced** by the in-repo single-agent pipeline on AWS. Read
  it only for the SSE event vocabulary (still largely accurate) and history.
- `docs/ingest-contract-v1.md` — corpus ingest contract; verify before relying on
  it.

## 10. Where the rest of the context lives (user auto-memory)

Loaded automatically when the project root matches (see section 3). Files under
`C:\Users\fshaher\.claude\projects\C--Users-fshaher--claude-projects-unifiedproductionbackend\memory\`:

- `lit-ai-platform.md` — app overview, how to run, env gaps.
- `seegerweissai-auth.md` — Cognito + Entra SSO migration, RBAC, topology.
- `seegerweissai-data.md` — DynamoDB / S3 / KMS data layer spec.
- `seegerweissai-discovery-port.md` — the Working Set / table-review port.
- `seegerweissai-research-search.md` — the research agent's full build history
  (web search repoint, RECAP/DocketBird, streaming, caching, latency rounds).
- `seegerweissai-handoff.md` — this handoff, in memory form.

If a memory names a file, function, or flag, verify it still exists before acting
on it. Memories reflect what was true when written.
