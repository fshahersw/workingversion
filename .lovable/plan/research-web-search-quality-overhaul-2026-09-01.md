# Research Web-Search Quality Overhaul

## Problem

Web search quality on the Research page is poor because:

- Queries are written by the weakest models in the chain (Haiku 4.5 router, Nemotron 120B sub-agents), producing generic single-shot queries.
- Each angle gets exactly one query with no reformulation or fan-out.
- Result ranking is basic lexical scoring with no recency decay, no authority tiers, and no relevance floor — weak and stale pages pollute the writer's context.
- Evidence extraction lumps pages together without filtering, so conflicting low-quality info reaches the writer.

## Approach

### 1. Multi-query fan-out per angle (`src/lib/agents/tools.server.ts`, `orchestrator.server.ts`)

- Each sub-agent generates 2–3 query variants per angle (primary + one reformulation + one date-anchored variant).
- Queries per angle run concurrently and results are merged and deduplicated by URL and near-duplicate title before ranking.
- Fan-out counts against the existing `AGENT_WEB_BUDGET` (4) and step budget (2), so total cost stays bounded.

### 2. Hardened ranking layer (`src/lib/agents/web-rank.ts`)

- Blended relevance score: lexical hit count combined with source authority tier.
- Authority tiers: primary legal sources (courts, agencies, PACER, gov, top-tier outlets) > reputable press > everything else.
- Recency decay with a hard cutoff: results older than ~18 months are dropped for date-sensitive categories unless nothing newer exists; supersession flagging when an older version of the same subject appears alongside a newer one.
- Relevance floor: results below a minimum blended score are discarded before they reach the sub-agent context.

### 3. Query-writing quality (`src/lib/agents/prompts.ts`)

- Tighten sub-agent prompts: require specific entities (party names, docket numbers, agencies, dates) in queries; ban generic one-line queries.
- Require a dated variant for news/enforcement/case-law angles so the recency anchor is deliberate, not just appended.

### 4. Writer protection (no model change)

- Keep all current models (Haiku router, Nemotron sub-agents, Sonnet 5 docket + writer).
- Feed the writer only the top-ranked, relevance-floored results with "as of" dates and superseded flags, so conflicting stale info never reaches the final answer.

## Technical details

- Files touched: `src/lib/agents/tools.server.ts`, `src/lib/agents/web-rank.ts`, `src/lib/agents/orchestrator.server.ts`, `src/lib/agents/prompts.ts`, plus tests in `src/lib/agents/web-rank.test.ts`.
- No new models, no new secrets, no engine flag changes — the multi-agent engine stays default.
- All fan-out stays within the existing 60s research wall-clock and the 2-step / 6-tool-call budgets.
- Tests: extend the web-rank test suite to cover blending, recency drops, supersession, near-duplicate dedup, and relevance floor.
