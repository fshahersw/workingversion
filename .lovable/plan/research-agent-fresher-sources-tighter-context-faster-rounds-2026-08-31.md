# Research agent: fresher sources, tighter context, faster rounds

## What the code does today (verified)

- `categorySearch()` in `src/lib/agents/tools.server.ts` fetches 3-6 results per gateway and pushes
  **1,500 raw characters per result** straight into the prompt and the source book. Five results =
  ~7.5k chars of unfiltered page text per tool call, per agent, per round.
- Recency handling is a single string trick: if the query has no year and the gateway is news /
  case law / enforcement, `currentMonthYear()` is appended. Nothing sorts, filters, or checks the
  `published` date that comes back — a 2021 hit ranks the same as a 2026 one.
- No dedupe: the same URL fetched by two sub-agents in two rounds enters the source book twice.
- Sub-agents get `maxTokens: 2500`, `maxSteps` 3-4, `MAX_ROUNDS = 3`. Each gateway call is its own
  model turn, so three categories = three serial turns of model latency.
- There is already a local BM25 (`src/lib/pile/bm25.ts`) and a source-tier table
  (`src/lib/source-tiering.ts`) that the web path does not use at all.

So: bulk context, no freshness ranking, and serial turns. All three are fixable without touching
models or the SSE contract.

## Changes

### 1. Freshness becomes a ranking signal, not a string suffix

- Parse `published` on every gateway result into a real date; results with none are marked
  `date: unknown` in the text the agent reads.
- Detect recency intent from the question/focus (`latest`, `recent`, `current`, `still pending`,
  plus any docket-status phrasing) and, for recency-sensitive gateways, over-fetch then **rank by
  a blended score**: relevance (below) x recency decay x source tier.
- On a recency query, if nothing in the top set is newer than ~12 months, do **one** tightened
  re-query with an explicit `after:<YYYY>` style anchor rather than accepting stale hits.
- Sorted newest-first in the text block, so the reader sees current material first.

### 2. Stop dumping pages; send extracted evidence

Replace the flat `trunc(r.text, 1500)` with a query-focused extract:

- Split the result text into sentences, score them with the existing BM25 tokenizer against the
  query terms, and keep the best 2-3 contiguous windows (~450 chars total) plus title, URL and date.
- Anything with no scoring sentence at all is dropped as off-topic instead of padded into context.
- Full text still goes to the source book for citation/reading; only the **agent prompt** gets the
  extract. Net effect: ~3-4x less context per call, higher signal density.

### 3. Candidate pool + local rerank (no extra model call)

- Ask each gateway for ~10 candidates (cheap, one HTTP call), then keep the top 4-5 after the
  blended relevance/recency/tier score.
- Global dedupe by normalized URL across the whole run, plus a max of 2 results per domain, so one
  aggregator cannot occupy a round.
- Only survivors enter the source book, which also shrinks what the writer has to read.

### 4. Fewer serial turns

- Add a single multi-category search tool so one model turn can fan out to 2-3 gateways
  concurrently, instead of one turn per gateway. The existing per-category tools stay for
  targeted follow-ups.
- With extraction and dedupe in place, drop `legal_research` step budget by one and keep the
  existing 28s sub-agent deadline; rounds end earlier because the second turn no longer exists
  just to add a second gateway.
- Cache stays as-is (TTL memo already keyed by gateway+query+limit); dedupe makes repeat calls
  across rounds free.

### 5. Writer sees dates, not vibes

- Every source line carries `dated YYYY-MM-DD` or `date: unknown`, and the writer prompt already
  has the temporal contract — it now gets sorted, dated evidence to honor it, so "as of" statements
  are anchored to a real newest-source date.

## Technical notes

Files: `src/lib/agents/tools.server.ts` (extraction, ranking, dedupe, multi-category tool),
a new small `src/lib/agents/web-rank.ts` (pure scoring/extraction, unit-testable),
`src/lib/agents/orchestrator.server.ts` (run-scoped dedupe set, step budget),
`src/lib/agents/prompts.ts` (tool description for the fan-out tool).

No model, SSE-event, or UI changes. New tests in `src/lib/agents/web-rank.test.ts`: recency ranking
prefers the newer of two equally relevant hits, extraction drops a no-match result, domain cap and
URL dedupe hold, extract length stays under budget.

Verification: typecheck + tests, then one `/research` run on a recency question comparing
`router_ms` / `agents_ms` / `total_ms` and the dated sources in the answer against the current run.

## Trade-off

Narrower per-source context. A question whose answer sits in an unmatched paragraph of a long page
could be missed by extraction — mitigated by keeping the full text in the source book so the
reader/citation path is unchanged.
