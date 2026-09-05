# Agent backend — black-box reference

The multi-agent research workflow behind the Conversations page does **not** live in this repo. It runs as edge functions in a separate backend project:

```
https://tbasvydiknulgtnsqvfp.supabase.co/functions/v1
```

This repo contains only the client caller (`src/lib/orchestrate.ts`) and the SSE reducer (`src/lib/use-chat.ts`). No function source, prompts, or corpus schema are available from here — we only have the public anon key, which cannot read function source or introspect the schema. Everything below was captured by calling the live endpoints on 2026-08-24 and recording what came back.

---

## 1. Endpoint inventory

| Endpoint | Called by this app | Role |
| --- | --- | --- |
| `POST /orchestrate` | `streamOrchestrate` — `src/lib/orchestrate.ts:87` | Multi-agent research loop. SSE. |
| `POST /quick-ask` | `streamQuickAsk` — `src/lib/orchestrate.ts:106` | One-shot answer over a selected passage. SSE. |
| `POST /followups` | `fetchFollowups` — `src/lib/orchestrate.ts:125` | Suggested next questions. JSON. |
| `POST /transcribe` | `transcribeAudio` — `src/lib/orchestrate.ts:162` | Audio → text (dictation). JSON. |
| `POST /search` | *not called* | Vector search over the corpus. JSON. Reachable with the anon key. |
| `POST /embed` | *not called* | Text → embedding vectors. JSON. Reachable with the anon key. |

Probed and **absent** (404): `news`, `prompt-suggestions`, `retrieve`, `ingest`, `health`, `chat`, `rag`, `corpus`, `agent`, `docs`, `documents`, `visa-bulletin`, `scrape`, `crawl`, `summarize`.

All endpoints authenticate with the anon key sent as both `Authorization: Bearer <anon>` and, where the client sets it, `apikey: <anon>`. There is no user-scoped auth on these functions today.

---

## 2. Request contracts

### `POST /orchestrate`

The client merges four objects into the body (`src/lib/orchestrate.ts:85-95`):

```ts
{
  // from litigationContext() — src/lib/system-prompt.ts
  system_prompt: string,        // Seeger Weiss persona / practice framing
  citation_contract: string,    // how the writer must cite

  // from classifyIntent() — src/lib/research-intent.ts
  focus_note: string,
  ...other retrieval hints,

  // caller-supplied
  query: string,                // wrapped by frameQuery(): "[Seeger Weiss LLP — ...] \n\n <text>"
  session_id: string,           // sessionStorage "sw.session_id"
  history?: { role: "user" | "assistant"; content: string }[],  // last 8 turns
  known_source_refs?: string[],
  stream?: boolean,
}
```

Only `query` is required — a bare `{query, session_id, stream:true}` runs fine; the persona and hints are optional steering.

### `POST /quick-ask`

```ts
{ question: string, context: string, ...litigationContext(), ...hints }
```

### `POST /followups`

```ts
{ query: string, answer: string, ...litigationContext() }
```

Response: `{ "followups": string[] }` — observed 3 items, short user-voice questions.

### `POST /transcribe`

```ts
{ audio_base64: string, mime_type: string }   // e.g. "audio/webm"
```

Response: `{ text?: string, error?: string }`. Not live-probed (needs audio); contract read from the client.

### `POST /search`

```ts
{ query: string, limit?: number }
```

Response:

```ts
{
  query: string,
  model: "voyage-law-2",
  count: number,           // returns 10 by default; `limit` did not reduce it in probing
  results: [{
    chunk_id: uuid, document_id: uuid, chunk_index: number,
    content: string, heading: string | null, section_path: string | null,
    similarity: number,            // cosine, ~0.38 on weak matches
    source_type: string,           // e.g. "ina"
    source_label: string, title: string, citation: string, source_url: string,
    effective_date: string | null, published_date: string | null, is_current: boolean,
    visa_categories: string[], countries: string[], topics: string[],
    document_metadata: object, chunk_metadata: object,
  }]
}
```

### `POST /embed`

```ts
{ texts: string[] }    // or { input: string | string[] }
```

Response: `{ model: "voyage-law-2", dimensions: 1024, count: number, total_tokens: number, embeddings: number[][] }`.

Calling it with the wrong key returns `{"error":"Provide 'texts' (string[]) or 'input' (string|string[])."}`.

---

## 3. `orchestrate` SSE event catalog

Captured from a real run (`"What is the current status of the Camp Lejeune water contamination litigation?"`): 37 events, 2 rounds, 1 agent, 8 sources.

Events arrive in this order:

**`run`** — once, first.
```json
{ "run_id": "62bea32f-…", "query": "<the framed query>" }
```

**`round`** — once per planning round. The router's reasoning is exposed verbatim.
```json
{ "round": 1,
  "reasoning": "…prose the timeline renders…",
  "scratch_note": "…private planning note…",
  "done": false,
  "dispatch": [{ "agent": "web_search", "focus": "…" }] }
```
The final round carries `"done": true` and `"dispatch": []` — that's the loop's exit signal, not a separate event.

**`agent`** — one per dispatched sub-agent, at start.
```json
{ "round": 1, "agent": "web_search", "focus": "…", "status": "start" }
```

**`tool_call`** — zero or more per agent. Tool names are namespaced by strategy.
```json
{ "round": 1, "agent": "web_search", "tool": "tavily_search:primary", "query": "…" }
```
Observed variants in one run: `tavily_search:primary`, `tavily_search:analysis`, `tavily_search:broad:news`. Corpus agents emit their own tool names with `scope`/`hits` fields (see `ToolCall` in `src/lib/chat-types.ts`).

**`agent_done`** — one per agent, on completion.
```json
{ "round": 1, "agent": "web_search",
  "summary": "markdown digest the agent wrote",
  "count": 8,
  "citations": ["title 1", "title 2", …] }
```

**`sources`** — once, after the last round, before writing.
```json
{ "sources": [{ "ref": "S1", "citation": "…", "authority": "web", "source_type": "web",
                "section_path": null, "source_url": "https://…",
                "effective_date": null, "is_current": null, "content": "…excerpt…" }] }
```
`ref` values are `S1…Sn` and are what the writer cites inline.

**`writer_start`** — once, the handoff to the writer.
```json
{ "round": 2, "sources": 8 }
```

**`delta`** — many; the answer streamed as text chunks. Chunks are uneven (a single word up to a full sentence), which is why `use-smooth-text.ts` re-paces them for display.
```json
{ "text": " of now" }
```

**`done`** — once, last.
```json
{ "run_id": "62bea32f-…", "status": "complete", "rounds": 2, "source_count": 8 }
```

**`error`** — emitted by the client-side reader on a non-2xx response (`{ "message": "HTTP 500" }`); the server may also emit its own.

### Known agent keys

From `src/lib/chat-types.ts`, matching what the router dispatches: `statutes_regulations`, `agency_guidance`, `case_law`, `visa_bulletin_data`, `web_search`, plus `router` and `writer` as pseudo-agents.

---

## 4. `quick-ask` SSE

Much smaller: only `delta` events followed by `done` with an empty payload.

```
event: delta
data: {"text":"The excerpt uses \"bellwether\" to…"}

event: done
data: {}
```

No `round`, `agent`, or `sources` events — it answers strictly from the supplied `context` and says so when the context doesn't cover the question.

---

## 5. Finding: the corpus is still the immigration corpus

`search` reports `model: "voyage-law-2"` and returns chunks from the **WR Immigration** dataset — INA sections, 8 U.S.C., USCIS guidance, with immigration-specific metadata fields (`visa_categories`, `countries`, `topics: ["ier","discrimination","i9"]`). Querying `"Camp Lejeune"` and `"bellwether"` both returned immigration statutes at low similarity (~0.38).

Practical consequence: for Seeger Weiss litigation questions, the four corpus agents (`statutes_regulations`, `agency_guidance`, `case_law`, `visa_bulletin_data`) have nothing relevant to retrieve. In the captured run the router dispatched **only** `web_search`, and every one of the 8 sources came back with `authority: "web"`. The litigation answers this platform produces today are effectively Tavily-sourced, not corpus-grounded.

The mass-tort corpus that was built out lives in the *other* project (`odwhzepghulspdzmzhhz`, `registry.*` — 308k documents, 1,040 matters). The agent backend is not wired to it.

---

## 6. What this doc cannot tell you

Not recoverable without a service-role key, DB connection string, or a Supabase access token for the agent project:

- Router prompt and stopping criteria — only the emitted `reasoning`/`scratch_note` prose is visible.
- Each sub-agent's system prompt, tool definitions, and retrieval scoping.
- Which LLMs are used, and for which stage (router vs. agents vs. writer vs. followups vs. transcribe).
- The writer's citation-enforcement logic.
- Corpus table/schema layout, chunking strategy, and ingestion pipeline behind `search`.
- Whether `search`/`embed` are internal-only by intent — they're publicly reachable with the anon key today, which is worth noting as an exposure.
