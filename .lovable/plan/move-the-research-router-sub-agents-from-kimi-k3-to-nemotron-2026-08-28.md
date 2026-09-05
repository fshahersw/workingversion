# Move the research router + sub-agents from Kimi K3 to Nemotron on AWS Bedrock

Short answer: yes, this is doable, and it's a contained change — the research loop already talks to Kimi through one swappable client file. But there is one thing that must be verified live before committing, because your reference file doesn't cover it.

## The one open risk: tool calling

The router and the four sub-agents don't just generate text — the sub-agents run a **tool-calling loop** (corpus search, docket lookup, document search, web search) and the router returns strict JSON plans. Your reference doc documents `invoke_model`, `converse`, streaming and auth, but says nothing about function/tool calling for `nvidia.nemotron-super-3-120b`.

So step one is a live probe against Bedrock with your key: send a `converse` call with a `toolConfig` and confirm the model returns a proper `toolUse` block. Depending on the result:

- **Tools supported** → full swap: router + all four sub-agents move to Nemotron.
- **Tools not supported** → router (JSON planning, no tools) moves to Nemotron; sub-agents stay on Kimi, or we keep Kimi as the automatic per-call fallback exactly like today. I'd report back rather than silently degrade the research loop.

## What changes

1. **New server-only client** `src/lib/agents/bedrock.server.ts`
   - Raw HTTPS to `https://bedrock-runtime.us-east-1.amazonaws.com/model/{modelId}/converse` with `Authorization: Bearer <key>` (the bearer-token mode in your reference). No boto3, no SigV4 — the app's server runtime can't run the AWS SDK's native pieces, and bearer auth avoids IAM setup entirely.
   - Exposes the same shape the loop already consumes: a `bedrockChat` (text + toolCalls) and a `runBedrockToolLoop` mirroring `runFireworksToolLoop`, so `tools.server.ts`, the SSE emitter and the timeline stay untouched.
   - Bounded backoff on 429/5xx; every other status surfaces as a real error in the UI.

2. **Provider selection in `orchestrator.server.ts`**
   - `planRound` and `runSubAgent` pick Bedrock when `AWS_BEARER_TOKEN_BEDROCK` is configured, else Fireworks/Kimi, else Claude — same three-tier fallback the code already has, just with Bedrock at the front.
   - Writer stays Claude Opus 4.8. Summarizer stays on Fireworks (Nemotron Lightning / Kimi) — untouched by this change.

3. **Secret**
   - One new secret, `AWS_BEARER_TOKEN_BEDROCK`, server-side only. I'll request it through the secure form when you approve.

4. **Verification**
   - Bedrock capability probe (tools + latency) before wiring.
   - Then one live `/research` run on a corpus-covered question and one on a corpus-miss question, comparing latency and citation quality against today's Kimi baseline, with the tool calls visible in the timeline.

## Notes

- Model id `nvidia.nemotron-super-3-120b`, region `us-east-1`, `converse` shape (provider-agnostic, so a later swap to `nemotron-nano-3-30b` for the sub-agents is a one-line change).
- `max_tokens` is set deliberately per role and `stopReason`/`finish_reason` is checked for `length` so truncated plans don't get parsed as complete ones.
- No prompt changes, no UI changes, no backend/corpus changes in this plan.
