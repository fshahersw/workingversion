# Context engineering for multi-turn research chats

## Where we are today

- The client sends the last 8 turns, each truncated to 1,200 characters, as flat `history`.
- `known_source_refs` is sent by the client but never read on the server — the source book starts empty on every question, so a follow-up re-retrieves everything.
- Nothing is persisted: a reload loses the whole conversation.
- The router sees raw history, so pronoun follow-ups ("what about the bellwether schedule there?") depend on the model reconstructing the referent from truncated text.

That works for one or two turns and degrades fast after that: cost grows, retrieval repeats, and earlier facts silently fall off the 8-turn window.

## What to build

### 1. A session memory object (the core change)

Replace flat history with a compact, maintained state carried between turns:

- **Rolling summary** — a running narrative of the conversation, rewritten every few turns by a cheap Kimi call, capped at ~1,500 characters.
- **Entity ledger** — matters, MDL numbers, courts, judges, parties, dates the conversation has locked onto, with the turn they came from.
- **Verbatim tail** — the last 2 turns in full (not truncated), because recency matters most.
- **Source ledger** — refs already retrieved this session with citation + title, so follow-ups reuse them.

Turn N sends: summary + ledger + tail, instead of 8 truncated turns. Smaller payload, more usable signal.

### 2. Question decontextualization

Before routing, one very cheap call rewrites the user's question into a standalone form using the entity ledger ("what about the bellwether schedule there?" -> "What is the bellwether trial schedule in In re Paraquat, MDL 3004, S.D. Ill.?"). The router and every subagent search then work from the standalone question. This is the single biggest quality win for long conversations, and it costs one small call.

The user still sees their original wording; the rewrite is internal.

### 3. Source carryover (finally use `known_source_refs`)

Seed the `SourceBook` with the session's already-retrieved sources before round 1. Ref numbering stays stable across a conversation (S4 in turn 1 is still S4 in turn 5), the router is told what it already has, and subagents are instructed not to re-run a search that a carried-over source already answers. Expected effect: follow-ups often finish in one round instead of two or three.

### 4. Persistence

Store conversations so a reload or a return visit resumes where it left off — messages, rounds, sources, and the memory object. Recommendation: Lovable Cloud (this app's own backend), scoped per authenticated user with RLS, not the corpus database. Adds a lightweight conversation list in the sidebar.

### 5. Guardrails

- Total context budget enforced server-side (summary + ledger + tail + sources), with sources trimmed first.
- Topic-shift detection: if the new question shares no entities with the ledger, treat it as a fresh thread — do not drag stale matters into retrieval.
- Ledger entries carry a turn index so the writer can prefer recent statements when they conflict.
- Answer quality is untouched: the writer keeps Opus 4.8, medium effort, the same token budget, the same adaptive formatting, and the same source contract. Nothing here shortens or constrains the answer — memory only changes what the router and subagents receive, never the writer's freedom.


## Build order

1. Memory object + decontextualization + source carryover (server-side, no schema needed) — the quality and latency win.
2. Persistence + conversation list — the durability win.
3. Budgeting, topic-shift reset, ledger conflict handling.

## Technical notes

- Memory maintenance and rewriting run on Kimi K3 via Fireworks with a small token budget; no Opus involvement, so the added latency is roughly one short call per turn (~1s), offset by fewer retrieval rounds.
- New server module `src/lib/agents/memory.server.ts`; `runOrchestration` takes a `memory` field instead of raw `history`, and seeds `SourceBook` from carried refs.
- `use-chat.ts` keeps the memory object in reducer state and sends it with each question; `orchestrate.ts` types the new body field.
- Persistence (step 2) adds `conversations` and `conversation_messages` tables in Lovable Cloud with `auth.uid()` policies and explicit grants; the corpus database is untouched.
