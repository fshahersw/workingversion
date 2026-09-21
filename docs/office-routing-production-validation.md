# Office production routing and Bedrock validation

Reviewed September 21, 2026. This bounded pass targets the original AWS Bedrock Office transport and its JEV routing policy. No AWS requests, credential reads, deployment, live provider tests or changes to model IDs/configuration were performed. The temporary Anthropic/Fireworks lane remains restricted to explicitly guarded local synthetic mode.

## Evidenced fixes

1. **Bedrock tool completion is checked before dispatch.** Previously, any `messageStop` allowed pending tools to reach the browser, without requiring a tool-use stop, closed tool blocks or unique IDs. Office now rejects malformed/unfinished frames or events, missing/duplicate identities, argument fragments outside an open block, tool content after completion, and tool proposals accompanying non-tool stops. A confirmed `max_tokens` result marks the entire batch unexecutable; complete malformed JSON arguments and disallowed names remain explicit repairable tool errors. Nothing executes in the stream parser itself; typed editor executors remain authoritative.
2. **Cancellation covers EOF and retry backoff.** The stream reader is cancelled on abort, checks cancellation before/after reads and before dispatch, and releases its lock. Aborting while an HTTP error body is consumed cannot enter an unnecessary backoff or start another request. Backoff listeners are removed after settlement.
3. **Short main-only abstention cache.** An unavailable or uncertain classifier result is cached for five seconds under the existing full-request/context/model/rubric/configuration key. Repeated unchanged tool rounds can stay on main without paying another classifier deadline. A changed context or expired entry is classified again; cancellation is not cached. Positive decisions retain their five-minute bounded cache. This is a deterministic avoidance of repeated calls, not a measured production latency claim.

The PDF agent's coordinated read-only `pdf_list_annotations` and `pdf_get_guide` names were also added to the existing app/mode policy. PDF implementation and UI are covered separately.

## JEV usage and production policy

**New production architecture requirement:** move TypeSafe requests behind AgentCore Gateway. The [external agent handoff](office-external-agent-handoff.md#5-first-follow-up-put-jev-behind-agentcore) specifies the adapter, IAM, transport, deadline and verification work. This report describes the current direct transport; it does not claim the gateway migration is complete.

Current [TypeSafe introduction](https://docs.typesafe.ai/introduction) and [fan-out documentation](https://docs.typesafe.ai/patterns/fan-out) describe independent questions evaluated against the same state in one request. Office already sends `task_class`, `changes_document` and `needs_legal_judgment` together. This pass tests that packet rather than adding sequential classifier calls or unsupported generation tasks.

[Confidence](https://docs.typesafe.ai/confidence) is a statistic of the returned probability distribution, not a guarantee that an answer is correct. The [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) explicitly caution about numerical precision, adversarial state, independent-answer inconsistencies and text generation. Accordingly, code continues to own permissions, target IDs, formulas, arithmetic, schemas and mutation ordering. JEV chooses a model tier; it does not authorize a write, validate an Office file or execute parallel mutations.

The checked-in testing parameters request `OfficeRouter=typesafe`, pinned `jev-1.13.0`, an 800 ms TypeSafe deadline and Office tiering on. These are configuration intent, not observed deployed settings. Code still defaults to the Bedrock classifier if no router mode is configured. In TypeSafe mode, unavailable credentials, invalid answers, timeouts and uncertain verdicts go directly to the main Bedrock tier. No extra Bedrock classifier request is added. Heavy/legal, image-dependent, failed-tool, continuation, queued-direction and active-compaction turns retain conservative main-tier gates; thresholds and rubric are unchanged.

`LOCAL_SYNTHETIC_MODE` and direct-provider selection remain rejected in production/AWS runtimes. Without that local selection, `streamWriterTurn` uses signed Bedrock ConverseStream. The test-only `bedrockFetch` seam is supplied directly by tests and is never read from HTTP request bodies.

## Validation and limits

- **65 focused regressions passed** across the actual Office Bedrock stream, routing, TypeSafe client/decision policy and existing local-provider tests. Bedrock tests use fragmented AWS binary event frames and inject only transport responses; no AWS signing/network call occurs. They cover valid parallel proposals, refusal/guardrail stops, missing block stops, duplicate identities, orphan/invalid arguments, malformed/trailing frames, truncation, cancellation and ordinary text replies.
- The abstention regression proves one router call for repeated unchanged context, a separate call for changed context, recovery after expiry and no cancellation poisoning. It also asserts the three questions share one request. This does not establish real JEV classification accuracy or production cache-hit rates.
- The framing check validates lengths/headers/payload completion and JSON shape; it does not add CRC verification to the shared AWS decoder. Native editor schema/ownership/revision checks remain required after inference.

Command: `node --import ../analysis/resolve-typescript.mjs --experimental-strip-types --test src/lib/writer/office-bedrock-stream.test.ts src/lib/writer/office-router.test.ts src/lib/agents/typesafe.server.test.ts src/lib/agents/typesafe-questions.test.ts src/lib/writer/office-local-provider.test.ts`

AWS release remains gated on the intended account, deployed app/engine identity, actual model/profile access and tool-stream behavior, IAM/ownership boundaries, cancellation/recovery, persistence and native downloads with synthetic fixtures. Current primary protocol references are [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html) and [MessageStopEvent](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_MessageStopEvent.html). Microsoft application interoperability still requires separate real Word/Excel/PowerPoint acceptance; neither these tests nor JEV decisions establish it.
