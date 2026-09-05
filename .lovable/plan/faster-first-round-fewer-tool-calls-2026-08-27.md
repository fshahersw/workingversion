# Faster first round, fewer tool calls

## What the logs actually show

Recent runs (from the agent logs):

```text
router 10.2s → dispatch docket_research, filings_documents, web_search
router 12.5s → dispatch web_search, web_search, web_search, docket_research   (178 sources)
router 20.2s → dispatch filings_documents, case_law, web_search
router 22.7s → dispatch case_law, web_search
```

Two separate problems, both confirmed:

1. **Dead air before round 1.** The router is a single non-streamed Kimi call that must finish
   completely before anything reaches the screen. It is asked to produce a phase, 2-4 sentences of
   prose reasoning, a scratch note, and a long focus paragraph per agent, with a 1500-token budget.
   That output generation is the 10-22 seconds. The prose it writes is no longer even displayed —
   the timeline was made structural, so most of those tokens are wasted latency.

2. **Tool-call sprawl.** The router can dispatch the same agent multiple times (three `web_search`
   agents in one round), and each agent runs up to 5 loop steps with unlimited parallel tool calls
   per step. One run fired 8+ web searches and collected 178 sources for a single question.

## Changes

### 1. Make the router's first output tiny

- Drop `reasoning` and `scratch_note` from the required plan output; keep `reasoning` as an optional
  single short line used only for the internal transcript, not required by the schema.
- Keep `phase` (2-4 words) as the first required field so it is generated almost immediately.
- Cap each agent `focus` to one sentence in the schema description and truncate server-side.
- Cut router `maxTokens` from 1500 to ~400 and trim the router prompt to the decision rules,
  removing the prose-writing instructions that no longer feed the UI.

Expected: first round dispatch in roughly 2-4 seconds instead of 10-22.

### 2. De-duplicate and cap the dispatch

- Collapse duplicate agents in a round (merge their focuses into one dispatch entry).
- Hard cap of 3 agents per round.

### 3. Give each sub-agent a real tool budget

- Reduce the sub-agent loop cap from 5 steps to 3.
- Add a per-agent tool-call budget enforced in the executor: max 5 tool calls total per agent,
  of which max 3 may be `web_search`. Once exhausted, further calls return
  "Tool budget reached — write your digest now from what you have" instead of executing, so the
  agent finishes cleanly rather than erroring.
- Prompt guidance: two or three sharp queries, not a sweep; do not re-run near-identical searches.

### 4. Keep the existing early exits

`ENOUGH_SOURCES = 20` and the no-productive-agents exit stay as they are.

## Technical notes

Files touched:

- `src/lib/agents/orchestrator.server.ts` — `PLAN_TOOL` schema, `parsePlan` (dedupe/cap/truncate),
  `planRound` (`maxTokens`), `MAX_AGENT_STEPS`, tool-budget wrapper around `execute`.
- `src/lib/agents/prompts.ts` — trim router prompt, add the sub-agent query-economy rule.

No changes to SSE event shape, timeline UI, models, or the writer. Verified by re-running a live
research query and reading `stage=router` / `stage=agent_done` timings in the logs.

Not in scope: the writer pass (40-80s) is a separate, larger change — say the word and I will plan
that next.
