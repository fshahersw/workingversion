# Fixing Tavily source selection and conflicting answers

## What's actually happening

Reading the Tavily path end to end, the conflicts are not one bug — they come from four things in how sources are picked and handed to the writer.

1. **Tavily's own relevance score is thrown away.** `tavily.server.ts` captures each hit's provider score, uses it only as a 0.2 floor, and then `rankResults()` in `web-rank.ts` re-ranks purely on keyword overlap (65% body term hits, 35% title term hits). A semantically perfect result with different wording loses to a keyword-stuffed page. This is the single biggest cause of weak picks.

2. **Authority barely matters.** Tier weighting is 1.0 / 0.9 / 0.78. A court or agency page beats a trade-press rewrite by 22% — not enough to overcome any keyword-overlap gap. So a `.gov` order and a blog summarizing it wrongly sit side by side.

3. **Stale and current sources are mixed with no supersession.** Recency decay bottoms out at 0.25 and undated pages get a flat 0.6, so a 2019 page can outrank a dated 2026 one. Nothing marks a source as superseded, and every kept source is dumped into the writer's SOURCES block flat, so the writer sees two different "current" states of the same matter.

4. **Every angle contributes its own Tavily grounded answer.** Angles run in parallel, each with a different time window / topic, and each `TAVILY ANSWER` goes into the transcript as an authoritative summary. Two angles on the same matter routinely produce two differently-dated summaries, and the writer treats both as findings. The parallel angles also share one `seen` set that only updates when each call finishes, so near-duplicate pages slip through and get double-counted as "corroboration".

## The fix

**Blend the provider score into ranking.** Final score becomes a blend of Tavily's semantic score and the local keyword relevance (roughly 55/45), still multiplied by recency and tier. Keeps the local signal for evidence extraction while stopping keyword-overlap from overriding semantics.

**Make authority actually weigh.** Widen the tier factors (about 1.0 / 0.82 / 0.6) and add a primary-source bonus for court, agency, and official-register hosts, so a trade-press rewrite of an order never outranks the order.

**Enforce recency and supersession.** For recency-intent questions, drop results older than a hard cutoff instead of decaying them, lower the undated prior, and tag each source with an as-of date in the SOURCES block. When two sources on the same subject carry different dates, the older one is labeled as superseded so the writer can say so rather than average them.

**Collapse the grounded answers.** Instead of pushing each angle's Tavily answer into the transcript as a standalone finding, mark them clearly as unverified provider summaries subordinate to the cited sources, and when angles disagree keep only the most recent one plus an explicit note of the disagreement. Tighten cross-angle dedupe so parallel angles reserve URLs before ranking, not after.

**Give the writer real conflict rules.** The current prompt says "name the conflict"; it needs the resolution order: primary source beats secondary, newer beats older on the same fact, and provider summaries never override a cited document.

## Technical notes

- `src/lib/agents/web-rank.ts` — add optional `providerScore` to `RankableResult`, blend it in `rankResults`, widen tier factors, add hard recency cutoff and dated/undated handling, expose a supersession helper.
- `src/lib/agents/tavily.server.ts` — pass the provider score through, reserve URLs in `seen` before ranking, raise the relevance floor, and restructure the digest so the grounded answer is subordinate to sources.
- `src/lib/agents/orchestrator.server.ts` — deduplicate and date-order `tavilyAnswers`, and emit the SOURCES block with as-of dates and superseded flags.
- `src/lib/agents/prompts.ts` — add the conflict-resolution hierarchy to the writer prompt.
- `src/lib/agents/web-rank.test.ts` — extend the existing suite for score blending, tier dominance, and the recency cutoff.

No backend, schema, or UI changes.
