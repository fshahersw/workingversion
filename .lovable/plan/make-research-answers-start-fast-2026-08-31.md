# Make research answers start fast

## What I can confirm from the code

I could not find timings for a recent run — the `[agent]` stage logs aren't present in the current
sandbox log buffer, so the exact per-stage split is unmeasured. What is verifiable is the shape of
the run: before a single word reaches the screen, a research turn makes this many *serial* model
hops, none of them streamed to the user:

```text
1. resolveQuestion   (Haiku, rewrites the follow-up)        blocking
2. groundCases       (Haiku + corpus/docket lookups)        blocking
3. router round 1    (Haiku, maxTokens 8000, tool schema)   blocking
4. sub-agents        up to 4 parallel, each up to 4 tool-loop steps
5. router round 2..N repeat 3+4 (cap 5 rounds / 120s budget)
6. writer            Sonnet 5 with thinking — FIRST visible token
7. updateMemory      another model call before "done"
```

Steps 1-3 are three full round trips of dead air with nothing on screen, and step 3 asks for an
8,000-token plan object with findings, open threads, confidence and a note — output tokens are
generated one at a time, so a large plan is directly latency. The research budget is 120s *on top*
of that, before the writer even starts.

## Plan

### 0. Measure first (one run)
Run one live research query and read the `stage=` lines (`memory_resolve`, `router`, `agent_done`,
`writer_done`, `run_done`) to get the real split. Everything below is sized from that; if a stage
turns out cheap, its change is dropped.

### 1. Kill the pre-router dead air
- Run `resolveQuestion` and `groundCases` concurrently instead of one after the other, and put a
  short timeout on each — on timeout, proceed with the raw question / no grounding.
- Skip `resolveQuestion` entirely when there is no session memory or the question is already
  self-contained (no pronoun/deictic reference) — a first question needs no rewrite.
- Skip `groundCases` when the question names no case, MDL, or docket.

### 2. Shrink the router's output
- Cut router `maxTokens` from 8000 to ~800. The plan is a phase, a tier, a done flag and up to 4
  short foci; the scratchpad prose is the expensive part.
- Make `findings` / `note` optional and cap their lengths in the schema so the model stops writing
  paragraphs into a machine-read object.

### 3. Cheaper rounds
- Round 1 for tier 0/1 questions should not run a router call at all: classify locally (short
  question, no research verbs, conversational follow-up) and go straight to the writer or a single
  sub-agent.
- Lower the whole-phase wall clock from 120s to ~60s, and cut `MAX_ROUNDS` to 3 (the tier caps
  already hold most questions to 1-2).
- Reduce `AGENT_STEP_BUDGET.legal_research` from 4 to 3.

### 4. Show progress sooner
- Emit the `round`/`phase` event before the router call resolves (an optimistic "Reviewing The
  Question" state), so the timeline moves during steps 1-3 instead of sitting blank.

### 5. Stop blocking the finish
- Move `updateMemory` off the critical path: emit `done` first, then refresh memory and emit the
  `memory` event after. The user's answer is already complete at that point.

## Technical notes

Files touched: `src/lib/agents/orchestrator.server.ts` (pre-pass concurrency, router budget,
round/tier caps, event ordering, memory after-done), `src/lib/agents/memory.server.ts` and
`grounding.server.ts` (skip conditions + timeouts), `src/lib/agents/prompts.ts` (trim router prompt
to match the smaller schema).

No change to the SSE event vocabulary, the models in use, the writer, or the chat UI.

Verification: re-run the same query before and after and compare `run_done` `router_ms`,
`agents_ms`, `writer_ms`, `total_ms`, plus time-to-first-token in the browser.

## Trade-off

This trims planning and research breadth, not writing quality. Deep multi-part questions still get
multiple rounds and full fan-out; simple ones stop paying for machinery they don't use.
