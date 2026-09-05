# Nemotron token budgets + accuracy/reasoning hardening

## 1. Token budgets

- Router (Bedrock plan call): `maxTokens` 700 → **4000**. The Fireworks/Claude router fallbacks (currently 400 / 1000) get raised to match so a fallback round doesn't truncate.
- Sub-agents (Bedrock tool loop): `maxTokens` 4000 → **12000**. Fireworks fallback raised to 12000 too; Claude fallback stays as-is at 6000.

## 2. Anti-hallucination hardening for the Nemotron sub-agents

Sampling:
- Sub-agent calls run at **temperature 0** (currently the 0.2 default) — factual extraction, not prose.

Prompt additions to `subAgentPrompt`:
- **Grounding contract**: every sentence in the digest either carries an `[S#]` ref or is an explicit statement of absence. No unreferenced claims, ever.
- **Quote-before-characterize**: before stating a holding, standard, order, deadline, or dollar figure, the agent must have the actual text from `read_document` or a `search_document_text` excerpt — a docket description alone supports only "an entry exists titled X".
- **No inference from silence**: absence of a filing in results ≠ it doesn't exist; say "not found in the tools I ran", not "there is no such order".
- **Named-entity discipline**: docket numbers, MDL numbers, judge names, dates, party names and amounts must be copied verbatim from a tool result — never reconstructed, normalized, or completed from memory. If a value is partially visible, report it partially.
- **Confidence tags**: each bullet ends with `[S#]` plus, where relevant, `(verified: document text)` vs `(docket description only)` so the writer can weight it.
- **Self-check pass**: a final instruction to re-read the drafted digest and delete any bullet whose facts it cannot point to in a tool result before emitting.

## 3. Better router reasoning / effort calibration

Prompt additions to `routerPrompt`:
- An explicit **effort ladder** replacing the current loose "two is typical" guidance:
  - Tier 0 — conversational / reformat / definitional → 0 agents, `done: true`, round 1.
  - Tier 1 — single lookup (one matter, one docket, one fact) → 1 agent, expect to finish in round 1.
  - Tier 2 — a matter's posture, a filing's content, a recent development → 2 agents, usually 1–2 rounds.
  - Tier 3 — multi-matter comparison, cross-jurisdiction, strategy, or a question with several independent unknowns → 3 agents, up to 3 rounds.
- **Classify then plan**: the router must silently pick a tier from the question plus prior state before choosing dispatches, and its `phase` string should reflect the tier's work, not generic "Researching".
- **Stop rules made concrete** (a round-2+ dispatch is only justified when at least one holds): a named entity is still unresolved; a prior agent returned empty on its core focus; the digests conflict on a material fact; or the question has a distinct sub-part nobody worked. Otherwise `done: true`.
- **Anti-loop rules**: never re-dispatch an agent for a reworded version of a query that already succeeded or already came back empty; the existing one-corpus-attempt budget stays and is restated in the ladder.
- **Escalation rule**: if round 1 came back thin on a Tier 3 question, round 2 should widen the *source type* (registry → authoritative external), not repeat the same tools.

Sampling: router calls run at **temperature 0.1** for stable, repeatable plans.

## Technical notes

Files touched:
- `src/lib/agents/orchestrator.server.ts` — `maxTokens` at the router call sites (~lines 413, 449, 470) and sub-agent call sites (~571, 597); add `temperature` to the Bedrock router/sub-agent calls.
- `src/lib/agents/prompts.ts` — rewrite the planning section of `routerPrompt()` and the grounding sections of `subAgentPrompt()`.

`runBedrockToolLoop` currently has no `temperature` option; it will pass one through to `bedrockChat`, which already supports it.

No backend, schema, or UI changes. Verification: one live `/research` run on a Tier 1 question (expect 1 agent, 1 round) and one on a Tier 3 question (expect fan-out plus a second round), checking the timeline and that citations resolve.
