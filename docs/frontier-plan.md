# Frontier research-agent build plan (verified)

Source: workflow wf_3a52dbba-c95 (map+research → synthesize → adversarial critic, goAhead=true, "mostly-sound"), 2026-09-05. Branch `feat/frontier-ux`. Driven solo by the CLI executor.

## Status — 2026-09-05 (updating as I build)

DONE (committed on `feat/frontier-ux`):
- `856af85` multi-turn context fix (topicShift no longer drops the tail)
- `354161e` WS1 router (Conversational/Fast/Think) — "thanks" now ~2.5s / 0 tools
- `ee3222e` WS2 first-person prose + writer/researcher contradiction fix
- `eea7040` WS3 reasoning-stream plumbing (LATENT — see finding) + "Composing…" gap indicator
- `2f55c95` WS4 per-call tool timeline (icons + running→resolved)
- `35fab40` WS6 deterministic citation + fact verification + trust line
- `d32f3ac` memory reliability: structured-output updateMemory (killed the parse-miss)

KEY FINDING: Bedrock redacts Claude extended-thinking TEXT (signature only, 0 chars at any effort). Raw reasoning CANNOT be streamed on this stack — frontier feel comes from the tool timeline + composing indicator, not streamed reasoning. WS3 plumbing kept latent (lights up on the Anthropic-direct path).

REMAINING:
- WS5 new tools (REST-first: CourtListener v4 citation-lookup, openFDA/PubMed/FederalRegister/eCFR; then code-interpreter/browser, gated) — bigger infra, deferred.
- WS7 prompt-caching verify (checkpoint ≥ 4096 tok) + TTFT logging (mode→model already in WS1).
- TTFA (~36s, dominated by hidden synthesis thinking) — needs an eval A/B on synthesis effort (quality trade-off), not more streaming.
- Visual browser smoke of the new UI (reasoning/composing/timeline/trust line).

---

## Phase-2 build plan (frontier capabilities) — synthesized 2026-09-05

Source: research workflow wf_6b149ac2-2d8 (9 briefs in its journal.jsonl) + adversarial critic. Synth agent stubbed; this is the hand-synthesized plan.

**Guardrails (from the critic — honor all):**
- AgentCore cold-start (~2-5s code-interp, browser microVM) must NEVER be a synchronous in-loop call that can blow the 40s deadline. Pre-warm a session pool; the per-tool 20s cap already backstops.
- Keep `RESEARCH_TOOLS` list STABLE across modes — mode-gating the tool *list* per-turn invalidates the prompt cache. Gate by budget/prompt, not by removing tools.
- CONSOLIDATE the 7 category search tools (all already route to `general___WebSearch`) before adding new tools — the list is ~17; adding pushes to 30+ and degrades tool selection.
- AgentCore Memory = LONG-TERM layer only; DynamoDB session memory stays the short-term source of truth (no split-brain). 7-day STM floor, KMS CMK, hashed actorId, manual prune sweep (LTM has no auto-TTL). PHI/work-product discipline.
- CourtListener PAID tier (Firas's account): **20/min, 250/hr, 1000/day**; citation-lookup throttle is separate (60 valid cites/min, 250/request). `memoTTL` caching stays good practice.
- Browser/Nova Act need a CONCRETE gap `fetch_page`+RECAP cannot cover (per "simplest solution first"); fetch_page remains primary. Honest deep-answer floor ~55-60s; do not promise sub-30s.
- Each phase gets its own verification + a success metric (latency / source-count / citation-accuracy).

**Phase 1 — Litigation REST tools + consolidation (NO infra, highest value, DOING FIRST).**
Consolidate category search; add: CourtListener **citation-lookup** (POST /api/rest/v4/citation-lookup/, Token; hardens WS6 verification), **openFDA** (api.fda.gov/{drug,device}/{event,label,enforcement}; free key → 120k/day), **Federal Register** (api/v1/documents.json; no auth), **eCFR** (api/search + versioner full-text; no auth), **PubMed** (E-utilities esearch→efetch XML; 3/s). New `*.server.ts` per source mirroring `courtlistener.server.ts` `cl()`/`qp()`; register + dispatch in `research-tools.server.ts`; all `memoTTL`-cached. Metric: verification rate ↑ (case cites confirmed), no eval tool-selection regression.

**Phase 2 — UX: upload files + mode toggle (frontend, no infra).**
Replace/demote the "All matters" button: `ChatView.tsx:634-655` (`MatterScopePicker` at :635; `MatterScopePicker.tsx` label :59/:94) → small icon chip + a paperclip AttachButton; drag-drop on the composer `<form>` (:590-596); file chips above the textarea; on submit thread extracted text into `use-chat.ts` `send()` `outboundMemory` (:336-342) as `attachments` (same channel as `carriedSources`). Add a Fast/Think/Research ModeToggle left of `:634` → `send()` param → server override of `classifyEffort`. Metric: uploaded file content reaches the writer like an [S#] source.

**Phase 3 — Code interpreter `run_python` (AgentCore).**
`@aws-sdk/client-bedrock-agentcore` (StartCodeInterpreterSession/InvokeCodeInterpreter/StopCodeInterpreterSession; does SigV4 + event-stream). Managed `aws.codeinterpreter.v1` (SANDBOX = no egress; fine for compute on gathered data; duckdb needs a PUBLIC-network custom interpreter via control-plane — defer). Cold-start-safe pool (2-4 warm, bg refresh). `executeCode` → text + base64 images. New `artifact` SSE → extend `AnswerMarkdown.tsx` mermaid `pre`-override (:68-80) with a `CodeResultBlock` (collapsed code + chart/img + download); `use-chat` `applyEvent` `case "artifact"`. Use cases: settlement/allocation math (Decimal), limitations/repose dates, pandas/matplotlib over gathered docket/AE data, file conversion, grep. Gate to Think / when-computation-needed. Metric: math+charts correct, no latency blowout (warm pool).

**Phase 4 — AgentCore Memory (long-term + learned preferences).**
Fire-and-forget `CreateEvent` after `updateMemory` (actorId=hash(cognito sub)); SUMMARIZATION + USER_PREFERENCE strategies (skip SEMANTIC — entities ledger does it; skip EPISODIC); `RetrieveMemoryRecords` once at session start → a `RECALLED FROM PRIOR SESSIONS (unverified)` block in `memoryBlock()`; preference hints appended to tone/format, capped ~300 chars (never override legal-correctness). 7-day STM, KMS, hashed actorId, prune sweep. Metric: cross-session recall works; retention verified.

**Phase 5 — Browser + live view + Nova Act (MOST GATED / highest effort).**
AgentCore Browser (`bedrock-agentcore` TS SDK `PlaywrightBrowser` + `generateWebSocketUrl` → `connectOverCDP`); live view (`generateLiveViewUrl` presign → `<BrowserLiveView>` React; DCV Web Client is vendored → Vite aliasing + WASM copy); Nova Act (Python-only, us-east-1, preview → bridge via Python subprocess OR AgentCore Runtime endpoint + `InvokeAgentRuntime`). Wrap as one `browse(url, instruction)` tool, gated to genuine JS/interactive gaps fetch_page can't handle. Metric: only fires on a real gap; live view renders. Flag: highest effort, preview-status risk.

**Deferred:** gateway targets / runtime subagents-as-tools — keep specialists INLINE (cheaper, no cold start, no extra hop) unless a concrete signal (isolation, different deps, long-running, team ownership) appears (per the runtime-subagents brief).

---

Three user-facing modes: **Conversational / Fast / Think**. Deep-research/multi-agent dispatch is DEFERRED — nothing user-facing is labeled "Research".

## Central mode config (owned by WS1, not split with WS7)

| Mode | Model | Tools | maxSteps | callBudget | research effort | synth effort |
|---|---|---|---|---|---|---|
| Conversational | Haiku 4.5 | none | 0 (skip loop) | — | — | — |
| Fast | Sonnet 5 | search+fetch+grep | 2 | ~{perTool:2,total:6} | low | low |
| Think | Sonnet 5 (opt Opus 4.8 synth via BEDROCK_SYNTHESIS_MODEL) | all gated | 5 | {perTool:4,total:18} | low | high |

Bedrock sampling constraint (reasoning on): temperature=1 or unset, topP 0.99-1.0, no topK. Adaptive thinking wire form: `additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort } }` (NOT top-level thinking).

## Workstreams (sequenced)

- **WS1 — Router + classifyEffort (seq 1, DOING FIRST).** `classifyEffort(query,history)->conversational|fast|think` in `research-intent.ts` (pure heuristic, zero latency, conservative: only unmistakable conversational inputs down-route; ambiguous → Think). Central mode→config map. Server recomputes mode AFTER `resolveQuestion` in `research-agent.server.ts`. Conversational → direct no-tool Haiku answer (`directAnswerPrompt()`); Fast/Think → tool loop with per-mode params (thread MAX_STEPS/effort/callBudget as params, not consts). Emit `mode` SSE event. GATE: verify no eval-set legal question classifies Conversational (false-negative ~0) before trusting the no-tool path.
- **WS2 — Prose warmth + writer-contradiction fix (seq 2).** `prompts.ts:251` delete "a separate writer composes it"; `:285` narrow first-person ban to PROCESS narration only (allow substantive "I found the CMO dated…[S3]"); `WRITER_FACT_STYLE`/`LEGAL_SYNTHESIS_FRAMEWORK` add first-person colleague voice while keeping [S#]-per-clause + fact density. Regression-check on eval-set.
- **WS3 — Stream reasoningContent (seq 3, co-develop w/ WS4).** ONLY add `onReasoning` display callback: `streamOneTurn` reasoningContent branch (bedrock-stream-tools.server.ts:224-233) calls `onReasoning?.(rc.text)` ALONGSIDE existing accumulation. Do NOT touch replay — it is already ASSISTANT-role at :415/:275-277 and works. Thread through streamConverseToolLoop → research-agent emit `reasoning` → use-chat reducer + Message.reasoning → ReasoningStream component.
- **WS4 — Tool-call + sub-agent timeline UI (seq 4, co-develop w/ WS3).** ToolCall.status running|done|error; TOOL_ICONS; upsert-by-id reducer; full-list ToolCallRow (spinner→check); ReasoningPanel unifying reasoning + tool timeline; mode badge. Browser-preview component = SHELL only until WS5 emits url/snippet.
- **WS5 — Capabilities (seq 5, REST-FIRST).** Ship plain-REST first: CourtListener v4 citation-lookup (feeds WS6), openFDA, PubMed E-utils, Federal Register, eCFR — new tool defs mirroring courtlistener.server.ts, gated by mode. DEFER browser + run_python until concrete need + process-warmth verified; prefer AgentCore MCP browser (`mcp__agentcore__browser_*`) over hand-rolled SigV4 CDP. AgentCore data-plane SigV4 service = `bedrock-agentcore`; control-plane = `bedrock-agentcore-control`.
- **WS6 — Verification (seq 6).** Deterministic [S#]→SourceBook check always-on (extend fact-check.ts, emit verification SSE, one bounded synth retry on orphans in Think). Optional adversarial verify Think-only, off by default (independent judge, not self-critique). Build on merged 856af85 memory fix.
- **WS7 — Latency/caching (seq 7, SCOPED to caching+TTFT only).** Prompt caching cachePoint after static system + tools block (verify ≥4096 cumulative tokens for Sonnet 5/Opus 4.8 floor); TTFT as its own metric; no latency-optimized inference for Sonnet 5 us-east-1.

## Critic corrections baked in
1. Reasoning replay is ASSISTANT-role and already works — WS3 = display callback only.
2. Fast budget must TIGHTEN (~6 total), the plan's "~128" was a typo.
3. Conversational no-tool short-circuit is the highest-severity failure — conservative heuristic + measured gate.
4. Mode→model centralized in WS1; WS3+WS4 co-developed; WS5 REST-first, browser/run_python deferred.

## Open questions (non-blocking)
- CourtListener account grandfathered vs post-2026-05-07 limits (5/min,50/hr,125/day)?
- AgentCore Start/Invoke/Stop IAM on app role (change-control)?
- TanStack server module-state warmth for AgentCore session reuse (else cold-start eats the 40s deadline)?
- Opus 4.8 synth escalation cost/latency ceiling?
