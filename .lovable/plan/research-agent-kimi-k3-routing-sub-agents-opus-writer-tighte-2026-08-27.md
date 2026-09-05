# Research agent: Kimi K3 routing + sub-agents, Opus writer, tighter UI

## What changes

1. **Model split**
   - Router (planning each round) → Kimi K3 on Fireworks.
   - All four sub-agents (docket, filings, case law, web) → Kimi K3 on Fireworks.
   - Writer (final answer, streamed) → Claude Opus 4.8, unchanged.
   - If `FIREWORKS_API_KEY` is missing or Fireworks errors on a call, that call falls back to the current Claude model automatically, so research never breaks.

2. **Corpus-miss guarding (prompts)**
   - Router: when the corpus agents return zero hits for a named case/MDL/party, the very next step must be an authoritative external pass (court/agency/published-opinion sources via web + case law), not another corpus retry.
   - Sub-agents: one corpus attempt with varied query terms; if empty, state "not in the registry" in one line and immediately pivot to authoritative external sources rather than padding.
   - Writer: must say plainly when a case is absent from the firm's registry and label which facts came from outside sources.

3. **Latency**
   - Round ceiling stays 3, but the router gets an explicit stop-early rule and a cheaper/faster planning pass (Kimi, low effort, smaller token budget).
   - Sub-agent tool loop step cap trimmed (8 → 5) and sub-agents are told to run their searches in one batch where possible.
   - Rounds already run agents in parallel; add early-exit so a round with only failed/empty agents ends the loop instead of triggering another plan call.
   - Skip the round-2 planning call entirely when round 1 already produced enough sources and every dispatched agent succeeded.

4. **Compact research UI**
   - Tighter type scale, reduced vertical padding and gaps in the agent timeline and streamed reasoning; rounds collapse to a single dense line once complete.
   - Streamed reasoning shown in a smaller muted block with a max height and internal scroll instead of expanding the page.
   - Slimmer message/composer spacing and a narrower source-panel row height, keeping the current brand styling.

## Technical notes

- `src/lib/agents/fireworks.server.ts` currently supports only single-shot, non-streaming, tool-less completions. It needs: OpenAI-style `tools`/`tool_choice` support, streaming deltas, and a `runFireworksToolLoop` mirroring `runToolLoop` in `anthropic.server.ts` (same `ToolUseBlock` shape so `tools.server.ts` and the SSE emitter are untouched).
- `orchestrator.server.ts`: swap `ROUTER_MODEL`/`SUBAGENT_MODEL` usage behind a small provider selector (`planRound` and `runSubAgent`), keep `WRITER_MODEL` on Claude with `streamMessage`.
- `prompts.ts`: edit `routerPrompt`, `subAgentPrompt`, `writerPrompt` for the deferral rules. No new prompt files.
- UI edits limited to `src/components/chat/ChatView.tsx` and `AgentTimeline.tsx` (plus minor `SourcePanel.tsx` spacing). No state/event changes.
- Verification: typecheck, then one live research run through `/research` on a query the corpus does not cover (e.g. 3M earplug MDL 2885) to confirm the deferral path, Kimi tool calls, and end-to-end latency vs. today's ~89s baseline.

## Risks

- Kimi K3 tool-call reliability is unproven in this loop; the Claude fallback per call is the mitigation, and the live run is the check.
- Kimi is slower per call than Nemotron but was the most parse-reliable model in the earlier bake-off, so quality holds while latency wins come from fewer rounds/steps, not a faster model.
