# SeegerWeissAI — Architecture Map

Technical companion to `docs/HANDOFF.md`. Covers the research pipeline (the
current focus), AWS wiring, data layer, the SSE contract, and a file index.
Accurate as of 2026-09-04; verify file:line against the code before relying on
specifics.

---

## 1. Request flow (research agent)

```
Browser (ChatView) ──POST /api/orchestrate (SSE)──▶ runResearchAgent()
                                                        │
   src/routes/api/orchestrate.ts ──────────────────────┘
                                                        │
   src/lib/agents/research-agent.server.ts              │
     resolve follow-up (only if prior context)          │
     seed SourceBook from session memory                │
     ▼                                                  │
   streamConverseToolLoop()  (bedrock-stream-tools.server.ts)
     ├─ research turns (Sonnet 5, ConverseStream + toolConfig)
     │    • model streams a 1-line status → onText → emit "thinking"
     │    • emits parallel tool_use blocks
     │    • tools execute in parallel under a budget → emit "tool_call"/"sources"
     │    • loop until no tool_use, MAX_STEPS, or deadline
     └─ synthesis turn (no new tools; tools kept on the wire)
          • streams the final answer → onAnswer → emit "delta"
     ▼
   emit "done" + refresh session memory (off the critical path)
```

- **Single agent, not multi-agent.** One strong model (Sonnet 5) decides its own
  tool calls and writes the answer. The old router → parallel sub-agents → writer
  design is retired (see the file index for the dead code).
- **Streaming end to end.** Research narration and the answer stream on separate
  channels (`thinking` vs `delta`), so the answer never appears in the thinking
  box.
- **Client reducer:** `src/lib/use-chat.ts` consumes the SSE events (RAF-batched
  text/thinking deltas). `src/components/chat/ChatView.tsx` renders the timeline
  (`AgentTimeline`), the `ThinkingStream`, and `AnswerMarkdown`.

## 2. Bedrock auth (SigV4)

- `src/lib/agents/bedrock-sign.server.ts` — `signedAwsFetch(service, url, opts)`
  signs a raw HTTPS request with **SigV4** using `@smithy/signature-v4`,
  `@aws-crypto/sha256-js`, and `@aws-sdk/credential-provider-node` `defaultProvider`.
  `signedBedrockFetch = signedAwsFetch("bedrock", ...)`. The same signer serves
  `bedrock` (LLM) and `bedrock-agentcore` (web search).
- Credentials come from the **default chain**: `AWS_PROFILE` in dev (SSO), an IAM
  role in prod. **No static keys. No bearer token.** The deprecated
  `AWS_BEARER_TOKEN_BEDROCK` was removed and must not return.
- Endpoints: `bedrock-runtime.<region>.amazonaws.com/model/<id>/converse` and
  `/converse-stream`.

## 3. Prompt caching

Two `cachePoint` placements keep a long tool loop fast and cheap:

1. **Stable prefix** — a `cachePoint: { type: "default" }` after the system block
   and after the tools list. Cached once, reused every turn.
2. **Moving breakpoint** — `withMessageCache()` appends a `cachePoint` to the
   **last** message on each turn, so the growing tool-result transcript is read
   from cache on every later turn (including the synthesis turn). Not persisted
   into the stored messages, so it does not stack.

Usage frames report `cacheReadInputTokens` / `cacheWriteInputTokens`; verified
cache reads of 11k-18k tokens per step. Cache reads are ~90% cheaper and do not
count against rate limits (this is what fixed the earlier 503 throttling).

## 4. Tools

Defined in `src/lib/agents/research-tools.server.ts` (`RESEARCH_TOOLS` +
`executeResearchTool`). Results funnel into one shared `SourceBook` (`[S#]` ledger).

| Tool(s) | Backend | Notes |
| --- | --- | --- |
| `search_authorities`, `search_case_law`, `search_regulatory_text`, `search_enforcement_history`, `search_scientific_literature`, `search_technical_environmental`, `search_judicial_parties`, `search_legal_news` | AgentCore IAM gateway `general___WebSearch` (SigV4) | Web search fan-out + rerank (`web-rank.ts`) + recency anchoring. All categories currently route to the one `general` target. |
| `fetch_page` | plain server fetch (`fetch-page.server.ts`) | URL → clean text + links. No headless browser. Output trimmed; `memoTTL` cached. Biggest accuracy lever after search. |
| `recap_search`, `recap_docket`, `recap_read` | CourtListener RECAP v4 (`courtlistener.server.ts`) | Token auth (`COURTLISTENER_API_TOKEN`). Free archive. `plain_text` / `filepath_local` PDFs. `memoTTL` cached. |
| `db_*` (`db_find_case`, `db_docket_sheet`, `db_calendar`, `db_search_filings`, `db_read_filing`, `db_get_case`, `db_graph_ask`) | DocketBird REST (`docketbird.server.ts`) | Key auth (`DOCKETBIRD_API_KEY`). REST, **not** MCP — DocketBird's MCP is OAuth-only, unusable headless. |

Budget: `callBudget { perTool, total }` + `deadlineMs`. `MAX_STEPS` and the
deadline live in `research-agent.server.ts`. Persistence rubric forbids the
"ask an attorney to pull from PACER" cop-out — exhaust DocketBird → RECAP → court
sites → web first.

## 5. AgentCore web-search gateways

- **In use:** `ClaudeAddinWebSearchIamGateway` — `AWS_IAM` auth, single `general`
  target (`general___WebSearch`), called via `signedAwsFetch("bedrock-agentcore", ...)`.
  MCP JSON-RPC 2.0, protocol `2025-03-26`. Overrides: `AGENTCORE_SEARCH_URL`,
  `AGENTCORE_SEARCH_TOOL`.
- **Blocked:** `ClaudeOfficeWebSearchGateway` — `CUSTOM_JWT`, 10 specialized
  category targets, but its authorizer only accepts **Microsoft Entra** tokens
  (the Office add-in tenant), not our Cognito pool. Needs pending Entra
  federation. Until then we use the single IAM gateway.

## 6. SSE event vocabulary

Emitted by `runResearchAgent`, consumed by `use-chat.ts`. (Event names are
strings; the shape is compatible with the older backend catalogued in the stale
`docs/agent-backend.md`.)

- `run` `{ run_id, query }` — first.
- `round` `{ round, phase, reasoning, done, dispatch }` — the phase string drives
  the timeline header (e.g. "Working the record").
- `agent` `{ round, agent, focus, status }` — the single "research" agent starts.
- `thinking` `{ round, agent, text }` — live status narration (the `ThinkingStream`).
- `tool_call` `{ round, agent, tool, query, hits? }` — one per tool use / result.
- `sources` `{ sources: Source[] }` — the running `SourceBook`.
- `agent_done` `{ round, agent, summary, count, citations }` — research complete.
- `writer_start` `{ round, sources }` — flips the UI to the answer; fired on
  synthesis start.
- `delta` `{ text }` — the answer, streamed.
- `done` `{ run_id, status, rounds, source_count }` — last.
- `memory` `{ memory }` — refreshed session memory.
- `error` `{ message }`.

Display metadata (`AGENT_META`, `TOOL_LABELS`, `agentMeta`, `toolLabel`) lives in
`src/lib/chat-types.ts`. The single agent renders as "Litigation Analyst".

## 7. Data layer

- **DynamoDB single table `sw-dev-app`** — PK `USER#<cognito-sub>`, SK prefixes for
  chat history, library, ACLs, and the review pipeline
  (`RTBL`/`RCOL`/`RROW`/`RCELL`/`RHIST`/`RRUN`, tableId embedded in child ids).
  ULIDs. Owner-scoped now; sharing is a later phase. See the `seegerweissai-data`
  memory for the v1 spec.
- **S3 `sw-dev-seegerweissai-475976462949`** — uploads via presigned PUT/GET; CORS
  configured. Backs the Library "Uploads" tab.
- **KMS** — provisioned for encryption.
- **Supabase** — retained ONLY as an external corpus / vector DB, not the app
  backend.

## 8. Model + permission constraints (important for latency work)

- **The SeegerWeissAI dev app** signs with the `AdministratorAccess-475976462949`
  profile, so it can invoke any model the account has access to (Sonnet 5 today;
  first-party Anthropic Haiku would work too).
- **Bedrock Latency-Optimized Inference is NOT available for Sonnet 5 in
  us-east-1** (verified: HTTP 400 from `scripts/probe-latency-optimized.ts`).
- **No Marketplace payment instrument** on the account → no third-party /
  Marketplace serverless models (e.g. Nvidia Nemotron). Use first-party ON_DEMAND
  models only. A "Haiku for tool turns" split is technically possible for the dev
  app (first-party), but carries quality + per-model-cache tradeoffs; not adopted.
- Separately, the **Claude Desktop 3P in-app** inference uses a narrower
  `ClaudeBedrockInference` permission set that allows only
  `us.anthropic.claude-sonnet-5` / `claude-opus-5` / `claude-opus-4-8` (+ global
  profiles); anything else 403s there. That constraint is for the desktop app, not
  this dev app.

## 9. Latency profile (measured)

Deep questions run ~55-60s as one continuous stream. Breakdown: Sonnet 5 TTFT
~1.4s/turn (model is not the bottleneck), ~5 serial research turns dominated by
**tool network time** (~25-30s), plus ~16s of fixed synthesis generation. We are
near the safe on-demand floor. The one remaining safe lever is **per-tool hard
timeouts** (cap a slow tool at ~8s). Provisioned Throughput is a cost commitment
that mostly helps concurrency, not single-request wall-clock.

## 10. File index (src/lib/agents)

**Active (research pipeline):**
- `research-agent.server.ts` — orchestration entry (`runResearchAgent`).
- `bedrock-stream-tools.server.ts` — `streamConverseToolLoop` (streaming loop +
  merged synthesis, message caching).
- `bedrock.server.ts` — Converse types, `converseOnce`, `bedrockEnabled`.
- `bedrock-sign.server.ts` — SigV4 signer.
- `research-tools.server.ts` — tool defs + dispatch.
- `agentcore-search.server.ts` — AgentCore gateway web search.
- `courtlistener.server.ts` — RECAP client.
- `fetch-page.server.ts` — URL → text.
- `docketbird.server.ts` — DocketBird REST.
- `tools.server.ts` — shared `SourceBook`, category search, `executeTool`.
- `prompts.ts` — `researchAgentPrompt()` + writing framework + shared style blocks.
- `memory.server.ts` — session memory (summary, entity ledger, tail, sources).
- `grounding.server.ts`, `web-rank.ts`, `log.server.ts` — support.

**Also present (other features):** `summarizer.server.ts` (Working Set /
Discovery), `corpus-v2.server.ts` (corpus/RAG), `anthropic.server.ts`,
`fireworks.server.ts` (alt providers used elsewhere), `doc-scan.ts`,
`json-extract.ts`, `verify.server.ts`, `run-state.server.ts`.

**Legacy / dead (retire after in-browser confirmation):**
- `orchestrator.server.ts` — old router→sub-agent→writer loop. **Caveat:**
  `research-agent.server.ts` still imports the `OrchestrateInput` and `Emit`
  **types** from here. Extract those types to a small shared module before
  deleting.
- `router.server.ts`, `tavily.server.ts` — old routing + Tavily search.

**Routes:** `src/routes/api/orchestrate.ts` (research SSE), `quick-ask.ts`,
`followups.ts`, `summarize.ts`.
