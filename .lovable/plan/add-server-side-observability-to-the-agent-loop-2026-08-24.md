# Add server-side observability to the agent loop

## Why

The last two research runs both returned HTTP 200 with no errors anywhere, and each finished in about 1m45s. That is all the current logs can show. The orchestrator reports its rounds, agent dispatches, tool calls, source counts, and failures only over the live SSE stream to the browser — nothing is recorded server-side. Because SSE always returns 200, a run where a sub-agent failed, the corpus returned zero hits, or the writer ran on thin research is indistinguishable in the logs from a clean run.

## What to add

Structured one-line server logs at each stage of a run, all tagged with the run id so a single run can be followed start to finish:

- Run start: run id, truncated question, history turn count.
- Each round: round number, whether the router said done, which agents were dispatched and their focus.
- Each tool call: agent, tool name, query, hit count, and duration.
- Each agent finish: agent, total hits, distinct citations, digest length.
- Writer: source count going in, answer length, total wall-clock.
- Failures: Anthropic status and message, sub-agent failures (currently swallowed into the digest text), and corpus/Tavily errors.

Also log timing per stage so the ~1m45s can be attributed to router vs. sub-agents vs. writer.

## Quick-ask and follow-ups

Same treatment, one line each: model, duration, and whether the call errored. Follow-ups currently returns an empty array on any failure, which is invisible today.

## Technical notes

- All logging goes in `src/lib/agents/orchestrator.server.ts` (wrap the existing `emit`, so every SSE event is mirrored to the log with no new call sites), plus `src/routes/api/quick-ask.ts` and `src/routes/api/followups.ts`.
- Log lines use a single `[agent]` prefix and a compact `key=value` shape so they are greppable through the worker log tool.
- Truncate question, focus, and digest text in logs; never log source bodies or the API key.
- No change to the SSE event vocabulary, the frontend, or the prompts — this is additive logging only.

## Follow-up (optional, not included unless you want it)

Persist a per-run record (question, rounds, agents, source count, duration, status) to the registry so runs can be reviewed after the fact rather than only in the last hour of worker logs.
