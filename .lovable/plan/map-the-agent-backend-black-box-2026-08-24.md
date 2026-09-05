# Map the agent backend black-box

The Conversations agent workflow runs entirely inside a separate backend project (`tbasvydiknulgtnsqvfp`). This repo holds only the client caller. Without a service-role key or access token, the function source can't be read — so instead, document the live contract of each endpoint from the outside and check it into this repo, so future work on the chat UI has a reliable reference.

Nothing about the running app changes. No backend calls that write or mutate.

## What exists over there

Confirmed live by probing:

| Endpoint | Used by this app | Role |
| --- | --- | --- |
| `orchestrate` | yes — Conversations | multi-agent loop, SSE |
| `quick-ask` | yes — Ask-AI popover | one-shot answer, SSE |
| `followups` | yes | suggested next questions, JSON |
| `transcribe` | yes — dictation | audio to text, JSON |
| `search` | no | retrieval, called internally by the agents |
| `embed` | no | embedding, called internally by the agents |

Confirmed absent: `news`, `prompt-suggestions`, `retrieve`, `ingest`, `health`, `chat`, `rag`, `corpus`.

## What gets produced

A new reference doc, `docs/agent-backend.md`, containing:

1. **Endpoint inventory** — the table above, with the exact URL for each and which file/line in this repo calls it.
2. **Request contract per endpoint** — every field this app currently sends (query, session_id, history, known_source_refs, stream, plus the persona and intent-hint fields injected from `system-prompt.ts` and `research-intent.ts`), typed.
3. **Observed SSE event catalog for `orchestrate`** — a real request is sent with a representative litigation question, every raw event captured, and each event name documented with its payload shape and the order it arrives in: round start, agent dispatch, tool calls, agent completion, source emission, answer tokens, done. This is the highest-value part, since `use-chat.ts` reduces these events today with no written spec.
4. **Same capture for `quick-ask`**, plus the plain JSON response shapes of `followups`.
5. **Probe results for `search` and `embed`** — a minimal request to each to learn its input shape and what it returns. These are the retrieval layer the agents call internally; knowing their contract means they could be called directly later if useful.
6. **Gaps** — anything the probing can't reveal (router prompt text, agent system prompts, model choices, corpus schema), listed plainly so nobody assumes the doc is complete.

## Technical notes

- Capture is done with a throwaway script under `/tmp` that streams each endpoint with the anon key and dumps raw SSE frames to a file; only the resulting doc lands in the repo.
- Requests are read-only by nature (question in, answer out). `transcribe` is skipped for live capture since it needs audio; its contract is documented from the existing client code.
- If a probe of `search` or `embed` returns 401 for anon, that gets recorded as a finding rather than worked around.
