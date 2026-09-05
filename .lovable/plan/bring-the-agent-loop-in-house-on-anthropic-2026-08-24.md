# Bring the agent loop in-house, on Anthropic

Today the whole research workflow — router, sub-agents, writer, prompts, tools — runs inside edge functions in a separate backend project we cannot read or edit. This app only sends a question and renders the stream. Two consequences: every prompt is invisible and unchangeable, and that backend's corpus is still the old WR Immigration dataset, so its four corpus agents retrieve nothing for mass-tort work and answers come from web search alone.

This plan rebuilds the loop inside this repo as server code, driven entirely by Anthropic models with your API key, and wires it to the Seeger Weiss registry corpus (1,040 matters, 308k documents, 209k docket entries).

## One correction on "edge functions"

This app is a TanStack Start app, so its own server code is the right home for the loop — a streaming server route at `src/routes/api/orchestrate`, with the agent logic in server-only modules beside it. That is the same thing functionally as an edge function (server-side, key stays secret, streams SSE), but it lives in this repo where you can read and edit every prompt, and it deploys with the app instead of separately. No Supabase edge functions needed.

## Models

| Role | Model | Settings |
| --- | --- | --- |
| Router | Claude Opus 4.8 | Planning each round: reasoning + which agents to dispatch |
| Sub-agents | Claude Sonnet 5 | Retrieval and digest work, run in parallel |
| Writer | Claude Opus 4.8 | High reasoning effort, large max-tokens, streamed |

Called through the official Anthropic API with your key stored as the `ANTHROPIC_API_KEY` secret, server-side only. I'll confirm the exact model identifiers against Anthropic's model list before wiring them, and surface Anthropic errors (rate limit, credit, overload) directly in the UI rather than hiding them behind a generic answer.

## The workflow being rebuilt

```text
question
  → ROUTER (Opus 4.8)  plans a round: reasoning + dispatch list
      → DOCKET AGENT      matters, parties, counsel, case status
      → FILINGS AGENT     docket entries + documents
      → CASE LAW AGENT    opinions and orders in the corpus
      → WEB SEARCH AGENT  Tavily, for anything outside the corpus
  → router decides: another round, or done
  → SOURCE ASSEMBLY  dedupe, rank, assign S1..Sn refs
  → WRITER (Opus 4.8, high effort)  streams the cited answer
```

Same event vocabulary the UI already speaks (`run`, `round`, `agent`, `tool_call`, `agent_done`, `sources`, `writer_start`, `delta`, `done`), so the reasoning timeline and source panel need no rework. The router's thinking streams into the timeline as it happens.

## Build order

**Phase 1 — the loop, in this repo**
- Streaming route `src/routes/api/orchestrate.ts` emitting the existing SSE contract.
- `src/lib/agents/`: `router.ts`, `writer.ts`, one file per sub-agent, an `anthropic.server.ts` client, and `prompts/` with one editable prompt per role — the thing that is currently invisible.
- Client points at the local route behind a flag, so we can A/B against the old backend and roll back instantly.

**Phase 2 — real corpus retrieval**
- Anthropic tool definitions over the registry: matter lookup, docket-entry search, document search, party/counsel lookup, court filters. Keyword and metadata search first — the corpus has no vector index today.
- Each tool returns compact citable rows that become `S1..Sn` sources linking to the S3-backed PDFs.

**Phase 3 — web search and the rest**
- Tavily agent with the primary/analysis/news strategies the old backend used.
- `followups` and `quick-ask` move in-house too (both small, both Sonnet 5).

**Phase 4 — retire the old backend**
- Flip the flag, delete the external caller path, keep `docs/agent-backend.md` as history.
- Dictation is the last thing still on the old backend; it moves after, since Anthropic has no transcription endpoint — options there are a separate small decision.

## Technical notes

- Secrets: `ANTHROPIC_API_KEY` (you provide) and `TAVILY_API_KEY` (for Phase 3). Both server-side only, never reaching the browser.
- Anthropic streaming is used for every call, including the router — long reasoning runs otherwise get cut by request timeouts, and the tokens bill anyway.
- The route is a raw HTTP server route rather than a server function because the UI consumes it as an SSE stream.
- Corpus access uses the existing pinned `odwhzepghulspdzmzhhz` client, read-only. No corpus or backend data is modified.
- Existing `src/lib/system-prompt.ts` (firm persona, citation contract, agent briefs) becomes the real prompt source instead of hints shipped to a black box.
