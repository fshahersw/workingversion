# Research agent: cleaner timeline, smarter routing, better tool names

## 1. Web search results capped at 10

- Hard-cap every web search call at 10 results (default stays 6): the `limit` clamp in the web search tool and the tool schema description both say max 10.
- Per-agent sweep stays as-is; only the per-call ceiling is enforced.

## 2. Remove the generic "researching" shimmer, replace with a model-written phase

- Delete the static `Planning research…` placeholder that appears before the first round.
- The router's `plan` tool gains a required `phase` field: a 2-4 word, title-case status phrase written for the attorney (e.g. "Locating the docket", "Checking bellwether orders", "Pulling agency records").
- The phase streams with the round event and is what the timeline shows next to the shimmer, replacing both the "Plan / Refine · Round N" label and the fixed "Thinking through the next step…" line.
- Until the first phase arrives, show only a small pulsing rail node with no text (no fake step).

## 3. Cleaner, more modern tool timeline

- Lighter rail: thinner line, softer node rings, no heavy shadows.
- Rounds render as a single compact row: node + phase text + subtle "complete" tick, no uppercase "Reasoning" header block.
- Agent rows: small colored dot, agent name, and a quiet pill with the result count; consistent 12px type scale and tighter vertical rhythm.
- Shimmer applies only to the currently running row; finished rows settle to muted text with a check.
- Collapsed pill restyled to match (rounded, muted border, single line summary).

## 4. Router awareness of conversational vs. research-heavy asks

- Router prompt gains an intent triage step: greetings, definitions, follow-up clarifications, formatting requests, and opinion/chit-chat get **zero or one** agent dispatch and `done: true` on round 1.
- Only fact-bound questions (specific matters, dockets, filings, science, agencies, news) get a multi-agent fan-out.
- Explicit rule: never spend more than one round on a conversational turn.

## 5. Better, varied web-search tool names

- Rename the agent label from "Legal Web Search" to **Open Web Research**.
- The displayed tool name varies with the search scope:
  - `primary` → **Authority Sweep** (courts, agencies, JPML)
  - `analysis` → **Deep Background**
  - `news` → **Litigation Wire**
- Corpus tools get matching plain-English display names (Matter Lookup, Docket Search, Document Text Search, Document Read).

## Technical notes

Files touched: `src/lib/agents/tools.server.ts` (limit clamp, tool descriptions), `src/lib/agents/orchestrator.server.ts` (`phase` in the plan tool + round SSE payload), `src/lib/agents/prompts.ts` (router intent triage + phase instruction), `src/lib/chat-types.ts` (`phase` on `Round`, agent label + tool display-name map), `src/components/chat/AgentTimeline.tsx` (restyle, phase rendering), `src/components/chat/ChatView.tsx` (drop the placeholder). No backend/schema changes; SSE event names stay the same, only the round payload gains an optional field.
