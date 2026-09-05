# Temporal awareness across the research agent

Scope: only inject and enforce current-date awareness. No new tools, no reconciliation pass, no router/writer restructuring — those stay on the shelf until this lands.

## Why

Nothing in the loop is told what today is. The router, every sub-agent, the writer, and the tool results all reason about "recent", "current", "still pending", and "latest" with no anchor, so a 2023 order reads as current and relative language goes unchecked.

## What changes

### 1. A shared temporal block

Add `temporalContext()` to `src/lib/system-prompt.ts`, computed per request:

```text
TEMPORAL CONTEXT
Today is Saturday, 2026-08-29 (UTC). Any date after this has not happened.
- Never call something "recent", "current", "latest", "ongoing", or "still pending" without naming the date it is anchored to.
- Write every date as YYYY-MM-DD, copied verbatim from a source — never inferred, completed, or shifted.
- Relative language in a source ("last month", "earlier this year") is resolved against the source's own date, not today's.
- A source with no date is undated; say so rather than assuming currency.
- When the newest evidence you have is materially older than today, state the as-of date instead of implying present-tense status.
```

Computed at call time (not module load) so a long-running server never serves a stale date.

### 2. Injected into every agent prompt

- `routerPrompt()` — so recency questions get planned as recency questions, and so "is this stale?" is a valid reason for another round.
- `subAgentPrompt()` — sits with the existing grounding contract; digests must date-anchor every currency claim.
- `writerPrompt()` — the answer never says "currently" without a date, and states an as-of date when the newest source is old.
- The summarizer prompts that judge currency (`summaryWriterPrompt`, `singlePassWriterPrompt`) get the same block.
- Also passed through `litigationContext()` so any backend consuming the system prompt sees it.

### 3. Dates surfaced in tool results

Tool output in `src/lib/agents/tools.server.ts` already carries `date_filed` / `effective_date` on most records, but inconsistently in the text an agent reads. Make it uniform:

- Every docket entry, document, matter, and web result line carries an explicit `filed YYYY-MM-DD` / `dated YYYY-MM-DD`, or the literal `date: unknown`.
- Web results include the publication date when the provider returns one, and `date: unknown` when it doesn't.

That way an agent can compare a source's date against today's date without guessing.

## Technical notes

- Files: `src/lib/system-prompt.ts` (new `temporalContext()`), `src/lib/agents/prompts.ts` (inject into router / sub-agent / writer / summarizer prompts), `src/lib/agents/tools.server.ts` (uniform date lines in result text).
- Prompt-level only. No model, token, effort, tool, schema, or UI changes.
- Verification: typecheck, then one `/research` run on a recency question, confirming the answer names an explicit as-of date instead of a bare "currently".

## Current writer parameters (for reference, unchanged by this plan)

- Model `claude-opus-4-8`, `maxTokens: 16000`, `effort: "medium"`, streamed, no tools.
- Router: `claude-opus-4-8`, `maxTokens: 4000`, `effort: "low"` (Bedrock Nemotron is primary at temp 0.1).
- Claude sub-agent fallback: `claude-sonnet-5`, `maxTokens: 6000`, `effort: "low"` (Bedrock Nemotron primary at 12k, temp 0).
