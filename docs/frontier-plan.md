# Frontier research-agent build plan (verified)

Source: workflow wf_3a52dbba-c95 (map+research → synthesize → adversarial critic, goAhead=true, "mostly-sound"), 2026-09-05. Branch `feat/frontier-ux`. Driven solo by the CLI executor.

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
