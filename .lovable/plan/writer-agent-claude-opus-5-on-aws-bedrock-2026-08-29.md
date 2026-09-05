# Writer agent → Claude Opus 5 on AWS Bedrock

Move the final writer of the research loop from the direct Anthropic API (`claude-opus-4-8`) to Claude Opus 5 on AWS Bedrock, using the same bearer-token credential the Nemotron router and sub-agents already use. Streaming, the agent timeline, sources, and citations all behave exactly as they do today; the answer itself gets better legal-synthesis discipline and adapts its depth to the question.

Nothing about the router, sub-agents, tools, corpus, or UI changes.

## 1. New Bedrock Claude client

A new server-only module sits beside `bedrock.server.ts` and speaks Opus 5:

- Model: `us.anthropic.claude-opus-5` (inference profile — the bare model id is rejected for on-demand calls).
- Auth: the existing `AWS_BEARER_TOKEN_BEDROCK`, `us-east-1`, plain HTTPS, no AWS SDK.
- Streaming via `invoke-with-response-stream`, so tokens still arrive word-by-word in the chat. Bedrock frames that stream in its own binary envelope, so the module includes a small decoder that unwraps each frame and reads the Anthropic events inside it (`content_block_delta` → visible text).
- `thinking: {type: "adaptive"}` plus an `output_config.effort` tier, and **no** `temperature` — Bedrock errors outright if a temperature other than 1 is sent with thinking on.
- The thinking block carries no readable text on Bedrock (only an opaque signature), so nothing new is shown in the UI; the existing "writing" state covers the gap before the first token.

Two safety rules baked in, straight from the verified reference:

- `max_tokens` is shared between invisible reasoning and the visible answer. Every writer call is sized generously (8k minimum, 16k for deep answers) so reasoning can never silently eat the whole budget.
- A response that finishes with reasoning but no visible text is treated as a failure, not an empty answer — it triggers the fallback below.

## 2. Fallback, so this can't take the app down

The writer tries Opus 5 on Bedrock first. If the token is missing, Bedrock errors, or the stream yields no visible text before any token has been emitted, it falls back to the current `claude-opus-4-8` path unchanged. Once tokens have started streaming, no retry happens (a half-written answer is never restarted). Every fallback is logged.

## 3. Adaptive writer depth

The router already classifies each turn into an effort tier (conversational / single lookup / scoped / deep) but that judgment is thrown away before the writer runs. The orchestrator will infer the same signal from what actually happened — agents dispatched, rounds run, sources gathered — and pick the writer's mode:

| Situation | Effort | Max tokens | Expected shape |
| --- | --- | --- | --- |
| No agents dispatched, no sources (greeting, follow-up on prior answer, reformat, definition) | low | 8k | A few sentences of prose, conversational, no headings |
| One agent / one round / small source set | medium | 10k | Direct answer plus the authorities that matter |
| Multiple rounds, multiple agents, or a large source set | high | 16k | Full layered synthesis with structure where it helps |

The mode is also stated in the writer's own instructions for that call, so the model's format matches the depth rather than defaulting to a memo every time. Multi-turn chat keeps working as it does now — prior turns and the session memory are still passed in, and a conversational follow-up stays conversational instead of re-running as a research memo.

## 4. Sharper legal-synthesis prompting

The writer prompt gains a condensed version of the reference's legal framework, layered on top of the existing rules (which already handle the no-preamble opening and citation markers):

- **Grounding first**: every substantive claim carries a source; conflicting sources are named as conflicts, not smoothed over; a holding is never stretched past what the excerpt supports; excerpt-only material is flagged as such.
- **Primary-source promotion**: the order, opinion, or statute outranks a summary of it.
- **Procedural precision**: motion vs. order; filed / briefed / argued / under advisement / granted / denied in part; amended vs. reversed vs. vacated vs. stayed; whether a ruling binds the whole MDL or one bellwether; the standard of review that applied.
- **Causation and science**: general vs. specific causation kept apart; the applicable causation test named; study design weighted (RCT > cohort > case-control > case report) with confounding and funding noted; amended Rule 702 described as the court-active gatekeeping standard it is.
- **Settlement framing**: headline vs. net-to-claimants, opt-in thresholds, approval status, and reported figure discrepancies stated as a range rather than silently picking one.
- **Preemption**: express vs. field vs. conflict named specifically, with live splits flagged.
- **Cross-analysis**: sub-agent digests touching the same issue are reconciled against each other, and second-order implications surfaced when they matter.
- **Formatting**: prose is the default; headings only when they aid navigation; tables only for genuinely tabular comparisons; bold used sparingly. No reusable template.

The existing anti-hallucination and temporal-anchoring rules stay exactly as they are.

## 5. Technical notes

- New file `src/lib/agents/bedrock-claude.server.ts`: Opus 5 request builder, event-stream frame decoder, `streamBedrockClaude()` returning the same shape the orchestrator already consumes.
- `src/lib/agents/orchestrator.server.ts`: writer block calls the new client with the chosen mode, falls back to `streamMessage` on failure; timings and `writer_ms` logging preserved.
- `src/lib/agents/prompts.ts`: `writerPrompt()` takes a mode argument and appends the legal-synthesis framework.
- No change to `anthropic.server.ts` behavior, the SSE contract, the summarizer, quick-ask, or followups.
- Verification: run a conversational turn, a single-lookup turn, and a deep multi-round research turn against the live loop, confirming streamed text, `[S#]` citations that resolve, correct depth per turn, and a clean fallback when the Bedrock path is disabled.
