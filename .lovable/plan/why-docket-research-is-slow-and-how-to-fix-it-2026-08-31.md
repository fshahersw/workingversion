# Why docket_research is slow — and how to fix it

## What docket_research actually is

It is one of the two research sub-agents (the other is `legal_research`). Its job is the real federal
docket, via DocketBird. It is given one focus sentence by the router and a tool belt:

- `db_find_case` — resolve a case name/number to a DocketBird `case_id`
- `db_docket_sheet` — the chronological entry list for that case (orders, motions, CMOs)
- `db_read_filing` — the full text of one entry
- `db_search_filings` — full-text search across filings
- `db_get_case`, `db_calendar`, `db_graph_ask` — metadata, deadlines, relationships

It runs as an agentic tool loop on Claude Haiku: model call → tool calls → model call → digest. Its
output is a short cited digest that goes to the writer, plus every retrieved record added to the
source book.

## What the logs show (measured, not guessed)

From `[agent]` log lines for recent runs:

```text
run a834643a  docket_research  ms=41260   tools: db_search_filings 1.1s, db_docket_sheet 2.5s, db_find_case 0.5s
run 686d56d1  docket_research  ms=40374   tools: db_find_case 0.6s, 0.7s, 0.7s
run 5548bfa2  docket_research  ms=31558   tools: 4 x db_find_case, 0.6-1.0s each  (then Bedrock aborted)
```

DocketBird is not the problem. Every tool call returns in 0.5-2.5 seconds; total tool time is about
4 seconds out of 40. The remaining ~36 seconds is the Haiku model itself — roughly 15-18 seconds per
model turn, at a step budget of 2-3 turns, all of it serial by construction (the model must see tool
results before it can decide the next call).

What is not yet measured, and must be before touching the loop: how many tokens each of those turns
actually generates. The final digests are tiny (65-226 characters), the output budget is 12,000
tokens, and the prompt instructs the agent to run a bullet-by-bullet self-check — which is the shape
of a model narrating at length and then emitting two lines. That is a hypothesis; the fix depends on
confirming it.

## Plan

### 1. Measure per-turn cost first (small, additive)

Log one line per loop step: step index, duration, stop reason, input/output tokens, and how many tool
calls that step produced. Bedrock's converse response already returns `usage` and `stopReason`; only
`stopReason` is currently read. One live docket question then tells us whether the 15-18s is output
generation, prompt processing, or provider latency — and the rest of this plan is chosen from that.

### 2. Stop paying for tokens nobody reads — and cap the flood of results

- Cut the sub-agent output budget from 12,000 to ~2,500 tokens. Nothing in the pipeline consumes more
  than a few hundred characters of digest, and a 12k ceiling invites narration.
- Rewrite the digest instruction to a hard shape: at most 6 bullets, no preamble, no narration of the
  self-check, no restating the focus. Keep the grounding contract (every bullet carries `[S#]` or is
  an explicit absence) — that is the anti-hallucination guarantee and it stays.
- Cap the result counts the web/search tools hand the model (your 30-40 results per agent comes from
  here): `legal_research` gateway tools default 5→**3** with hard cap 10→**6**; `db_search_filings`
  default 8→**4**, cap 15→**8**; `db_docket_sheet` default 40→**20**, cap 80→**40**. The defaults are
  what actually bite — the model almost never passes an explicit `limit`, and every returned record is
  also added to the source book, so one round of default calls was producing ~30-40 sources per agent.
- Prompt mirror: tell the agent it gets FEW results by design and to rely on the per-call "NEXT STEP"
  pointers rather than requesting more.

### 3. Remove a whole model turn from the common case

The expensive unit is a model turn, so the win is turn count, not tool count.

- When the grounding pre-pass already resolved the case (`RESOLVED CASE CONTEXT` present, with a
  docket snapshot), pre-load the docket sheet for that `case_id` into the agent's first user message
  instead of making it call `db_docket_sheet`. The agent then goes straight from turn 1 to a digest.
- Have `db_find_case` return the top case's recent docket entries inline rather than only the
  `case_id` plus a "NEXT STEP: now call db_docket_sheet" instruction. That instruction currently
  guarantees an extra round trip for information we could have fetched in parallel server-side.

### 4. Make the misses cheap

Runs 686d56d1 and 5548bfa2 burned 30-40 seconds on nothing but failed or repeated `db_find_case`
calls. Add a code-level short circuit: after two `db_find_case` calls with zero usable hits, the tool
layer returns a terminal notice ("this case is not in the index — write what you have, or defer to
legal_research") so the agent stops trying and the round ends instead of spending its whole budget
discovering absence.

### 5. Cap the agent, not just the round

Add a per-dispatch wall-clock budget (about 25 seconds) inside the tool loop. When it is exceeded,
the loop stops issuing model turns and returns whatever digest text and sources it has. Today a slow
provider turn can eat the entire 60-second research budget, and the run then early-exits with
`reason=research_budget` (visible in the logs at 86s).

## Technical notes

Files touched:

- `src/lib/agents/bedrock.server.ts` — surface `usage` from converse; per-step timing/usage callback
  in `runBedrockToolLoop`; per-dispatch deadline.
- `src/lib/agents/orchestrator.server.ts` — sub-agent `maxTokens`, step/deadline wiring, pre-loading
  the resolved docket sheet into the first user message.
- `src/lib/agents/tools.server.ts` — inline recent entries in `db_find_case`; terminal notice after
  repeated zero-hit lookups.
- `src/lib/agents/prompts.ts` — tighten the sub-agent digest shape (grounding rules unchanged).

Verification: run the same insulin MDL 3080 question and compare `stage=agent_done ms=` and the new
per-step lines against today's 41s baseline. No change to SSE events, the timeline UI, or the writer.
