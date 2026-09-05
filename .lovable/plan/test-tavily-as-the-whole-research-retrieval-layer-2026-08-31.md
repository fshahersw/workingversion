# Test Tavily as the whole research retrieval layer

Goal: behind one env switch, `/research` stops fanning out to the seven AgentCore gateways and the DocketBird tools and instead runs Tavily advanced search with an included answer. Old path stays intact so we can flip back and compare.

## How it behaves

- `RESEARCH_ENGINE=tavily` turns the new path on. Unset or `agentcore` keeps today's behavior exactly. Nothing is deleted.
- Router still classifies effort (the existing 4-tier ladder) and still handles small talk on the fast path.
- Simple / tier-1 questions: one Tavily call, and Tavily's own answer is streamed as the reply with its sources attached — no sub-agent turn, no writer turn. Expected sub-2s answers.
- Medium and deep questions: 2-4 Tavily calls fired concurrently (one per research angle the router names), results merged, deduped and tiered, then Claude Opus writes the answer with `[S#]` citations as it does today. Tavily's per-query answers go in as extra grounded evidence, never as the final text.
- Recency: the router's recency signal maps to Tavily `time_range` (`week` / `month` / `year`) and `topic: news` for news-shaped angles, so we drop the "append current month/year to the query" hack.
- Open web, no domain allow-list. Primary-vs-press ordering comes from the existing tier scoring plus Tavily's relevance score.

## Right-hand panel

- Each result carries Tavily's `favicon`, its score, and its published date into the source record, so the panel shows the real site icon instead of the Google favicon proxy (proxy stays as fallback).
- Sources are grouped and sorted as today (primary → official → reported), newest first inside a tier.
- Uncited-but-retrieved results keep feeding the existing Related cards, which Tavily's wider result sets should fill out better.

## Trade-off you should know about

Turning the flag on removes docket capability for that run: no docket sheet, no full filing text, no case calendar, no relationship graph. Questions like "what's the latest CMO in 3080" will only get whatever Tavily finds on the open web. That is the point of the flag — we measure whether Tavily's speed and ranking are worth it before deciding anything permanent.

## Technical notes

- New `src/lib/agents/tavily.server.ts`: single `tavilySearch()` wrapper (`search_depth: "advanced"`, `include_answer: "advanced"`, `include_favicon: true`, `max_results`, `time_range`, `topic`), bounded retry on 429/5xx, run-scoped URL dedupe and per-domain cap reused from `web-rank.ts`.
- `src/lib/agents/tools.server.ts`: one `web_research` tool for the Tavily engine; existing category + `db_*` tools stay behind the flag.
- `src/lib/agents/orchestrator.server.ts`: engine selection, concurrent multi-angle dispatch, direct-answer short circuit for tier-1, unchanged SSE event contract so the timeline and UI need no changes.
- `Source` gains optional `favicon` and `score`; `SourcePanel` prefers `favicon` when present.
- Reuses the existing `TAVILY_API_KEY` secret (already configured for the Home intel pipeline).

## Verification

Typecheck + existing tests, then live `/research` runs on the same three questions under both engines — one simple, one recency-sensitive, one docket-specific — comparing `total_ms` and citation quality, and screenshotting the panel with real favicons.
