# Never let a docket-only round answer "can't find it"

Today the router can dispatch `docket_research` alone. When DocketBird has no match (or the case is too large to snapshot), that round returns zero hits and the writer says it cannot find the information — even though a dated web/news search would have answered it. Verified in `src/lib/agents/orchestrator.server.ts` (dispatch list is used as-is after focus dedupe) and `src/lib/agents/prompts.ts` (router is told BOTH agents are often right, but nothing enforces it).

## What changes

1. **Hard pairing rule (code-enforced).** In the orchestrator, after the router's plan is parsed and deduped: if the round dispatches `docket_research` and no `legal_research`, inject a parallel `legal_research` dispatch automatically. Its focus is derived from the resolved case/question plus an explicit "as of <current month year>" recency anchor. This runs in the same `Promise.all` fan-out, so it costs no extra wall-clock time.

2. **Router prompt rule.** Add an explicit invariant to the router prompt: any round that touches the docket MUST also dispatch `legal_research` with a recency-anchored focus; docket-only rounds are not allowed. Keeps the model's own plans consistent with the enforcement instead of relying on the fallback.

3. **Date-anchored search queries.** Sub-agent guidance and the category-search tool get a current-date anchor: when a `legal_research` query has no explicit year/date, append the current month and year so news and case-law gateways return the latest state rather than stale top hits.

4. **No-result behavior.** When the docket agent comes back empty, the parallel web findings are already in the source book, so the writer synthesizes from those and states the docket gap precisely ("no DocketBird entry found; per <source>, as of <date> …") instead of a flat refusal. The writer prompt gets one line making that the required shape.

5. **Guards.** The injected dispatch respects `MAX_DISPATCH` and the tried-foci dedupe (it is registered like a normal focus so later rounds do not repeat it), and it is skipped for tier 0 / small-talk turns where no tools run at all.

## Technical notes

- Files: `src/lib/agents/orchestrator.server.ts` (dispatch injection + focus derivation), `src/lib/agents/prompts.ts` (router invariant, sub-agent recency line, writer gap-shape line), `src/lib/agents/tools.server.ts` (date anchor on category queries).
- Tool caps, models, budgets, and round caps stay exactly as tuned.
- Verify with a live `/research` query naming a case DocketBird won't resolve: logs should show two parallel dispatches (`docket_research,legal_research`) in the same round and an answer sourced from the web hits.
