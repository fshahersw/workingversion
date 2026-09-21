# Office and PDF engineering handoff

Prepared September 21, 2026. This is the continuation contract for an external coding agent, with completed work separated from the next tasks. Start from `codex/office-pdf-quality`, which contains four implementation commits through `b3fd979a4ca06ced9169c4444f66363b6a886675`, plus this handoff. Original public baseline: `e595931af932953a0f3ef70e9cfb80a837c001bc`.

For the subsequent Research and Discovery audits and implementation instructions, read the [combined handoff index](agent-handoff/README.md) and [verification runbook](agent-handoff/IMPLEMENTATION-RUNBOOK.md). The owner has designated Frontier Research as legacy and retiring; optimize the active Research pipeline. Shared transport/AgentCore changes must preserve this Office delivery as well as the Research/Discovery contracts.

## 1. Understand the user's requirements

Improve the existing litigation platform's Writer, Sheets, Slides, and PDF workflows for speed, accurate native editing, long multi-round tasks, useful progress, and reliable Save/Download. Preserve the existing browser editors and AWS Bedrock architecture. Use compact JEV decisions wherever measured classification quality and latency justify them; use deterministic native code for arithmetic, schemas, permissions, targets, formatting and file operations. Independent reads and analyses may run in parallel; dependent changes to a document must be ordered and verified.

The user specifically reported Writer Save/Download failures with tables/diagrams, a failed complex mock Tesla quarterly workbook, inaccurate selection/page targeting, and poor PDF functionality. These have targeted fixes and synthetic acceptance evidence. They are regression scenarios, not permission to replace the editors wholesale.

**Newest instruction:** production TypeSafe/JEV API access belongs behind AWS AgentCore Gateway, with the actual vendor call made by the gateway's adapter/target. This is still to implement. Do not add new external research services in this pass. Keep extension points ready and report unavailable tools honestly.

The public URL is `https://testing.seegerweiss.com`. No live AWS state was verified in this work because the requested SSO profile was unavailable and the user deferred AWS configuration. Repository parameters are configuration intent, not evidence of deployed state. The release runbook distinguishes testing account `475976462949` from production account `247011205599`; confirm the intended account before any later deployment. The current request authorizes repository delivery, not an AWS deployment.

## 2. Read in this order

1. [Delivered changes and validation](office-native-parity-delivery.md): authoritative summary for the final implementation checkpoint. Older reports describe earlier checkpoints and can have smaller test counts.
2. [GenOffice parity matrix](genoffice-tool-parity.md): exact tool coverage, browser adaptations and unsupported capabilities. Name coverage is not identical semantics or universal Microsoft Office compatibility.
3. [Local setup and AWS boundary](office-local-development.md): synthetic authentication, emulators, native dependencies, provider guards, architecture packaging constraints.
4. [Routing and Bedrock validation](office-routing-production-validation.md): JEV questions, conservative gates, cache, binary streaming protocol and cancellation. Its direct-TypeSafe configuration is the current implementation, superseded as a production design by section 5 below.
5. [Long workflow acceptance](office-complex-workflow-validation.md) and [agent reliability](office-agent-reliability.md): repair, compaction, continuation, workbook checks and source fidelity.
6. [Writer](writer-native-parity-validation.md), [Slides](slides-native-parity-validation.md), and [PDF](pdf-native-parity-validation.md) evidence: native features, preservation, limitations and tests.
7. [Architecture](ARCHITECTURE.md), [infrastructure](../infra/app/README.md), [release runbook](release/DEV-TO-PROD.md), and the selected environment's checked-in parameters. Reconcile older Drafts/export descriptions against the actual native routes; do not assume all historical prose describes the current Office UI.

Upstream reference was inspected at GenOffice commit `476e5023c9a4bc459ca6de7b1d697ab25d94850e`. Read its actual tool schemas, prompt guides, handlers and serialization code, not just README descriptions. To regenerate the source inventory without mixing a moving upstream with this acceptance baseline:

```sh
git clone https://github.com/genspark-ai/genoffice.git ../genoffice-reference
git -C ../genoffice-reference checkout 476e5023c9a4bc459ca6de7b1d697ab25d94850e
node scripts/audit-genoffice-tools.mjs ../genoffice-reference
```

Read TypeSafe's [introduction](https://docs.typesafe.ai/introduction), [fan-out](https://docs.typesafe.ai/patterns/fan-out), [confidence](https://docs.typesafe.ai/confidence), and [JEV limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13). The [awesome-jev collection](https://github.com/yibie/awesome-jev) is discovery material; use the vendor's documented contract for implementation. Do not treat JEV confidence as proof of correctness or JEV as a text-generating subagent.

## 3. Locate the architecture before editing

| Concern | Primary files/directories | Contract to preserve |
| --- | --- | --- |
| Production model stream and mode allowlists | `src/lib/writer/inference.server.ts`; `src/lib/writer/tool-policy.test.ts`; `src/lib/writer/office-bedrock-stream.test.ts` | Signed Bedrock ConverseStream, completed valid tool blocks, unique identities, cancellation; invalid output never silently executes. |
| JEV client and decision rubric | `src/lib/agents/typesafe.server.ts`; `typesafe-questions.ts`; `src/lib/writer/office-router.test.ts` | Batched questions, pinned model, typed probability validation, conservative fallback, context-aware bounded cache. |
| Existing AgentCore client and signing | `src/lib/agents/agentcore-search.server.ts`; `bedrock-sign.server.ts`; `src/lib/config.server.ts` | Reuse the signing pattern, not the search tool or search result parser. Search config must remain independent. |
| Shared agent loop and UI | `src/writer/packages/agent-core/src/`; `src/writer/packages/ui/src/`; `src/office/shared/` | Ordered mutations, bounded parallel reads, recovery, progress, cancellation, scoped session ownership, verified completion. |
| Writer tools and native DOCX | `src/writer/renderer/ai/`; `src/writer/packages/docx-engine/src/`; `src/writer/platform/adapter.ts`; `save-request.ts` | Exact captured selection and stale guards; preserve unrelated OOXML; explicit body replacement does not inherit old paragraph breaks. |
| Sheets | `src/office/sheets/`; `services/office-engine/server/`; `services/office-engine/native/xlsx-engine/` | Native workbook formulas/charts, authoritative operations, worker lifecycle and error propagation. |
| Slides | `src/office/slides/`; `src/writer/packages/pptx-engine/`; `services/office-engine/vendor/packages/pptx-engine/` | Browser and retained engine agree. Keep canonical and vendor operation implementations synchronized. |
| PDF | `src/office/pdf/PdfWorkspace.tsx`; `skill.ts`; `extended-tools.ts`; `pdfium-*`; `page-operations.ts`; `export-delivery.ts` | Current revision/object IDs, source edits, bounded self-hosted worker, honest font limits, separate saved derivative files. |
| Save/create/download | `src/lib/office/revision-upload.server.ts`; `create-upload.server.ts`; `src/office/shared/revision-transfer.ts`; `create-transfer.ts`; `file-delivery.ts`; native content routes under `src/routes/api/` | Owner/document/revision/hash/operation identity, staged large uploads, exact saved revision downloads, replay-safe creation and saves. |
| Archive validation and delivery tests | `src/lib/office/validate-archive.server.ts`; `archive-complex-documents.test.ts`; revision/create/replay tests | Preserve absolute expanded-size limits, actual size, CRC and XML validation. Repetitive legitimate table XML must save. |
| Infrastructure | `infra/app/app-foundation.cfn.yaml`; `app-runtime.cfn.yaml`; `infra/office-engine/`; `scripts/build-lambda.mjs`; `package-lambda.mjs` | Real architecture-specific native artifacts, signed storage CORS, abandoned staging expiry, exact IAM resources. |

There are two useful kinds of small execution tools: native typed Office operations, and existing isolated code-interpreter facilities. Use native operations first for formulas, matching, styles and serialization; these need no model call for execution. Repository `rg` and local Python are engineering tools, not automatically user-facing agent capabilities. Do not expose arbitrary browser shell/host filesystem access or bolt unsandboxed Python onto the app.

## 4. Know what is complete and what remains

Completed: Writer's 17 added tools and 23 atomic operations; all 61 upstream Slides operation names; all 55 upstream Sheets workbook operation names (58 local); source PDF text/image operations, annotations/navigation/page operations, and separate Library extraction/split delivery. The latest PDF tool surface has 18 tool definitions. Its guide is `pdf_get_guide`.

Writer Save failures were addressed in both archive validation and transfer. Files above 3 MiB use signed staging PUT plus a small authenticated commit. A 7,515,642-byte DOCX passed save, replay, creation, tamper rejection and exact-hash download. Session generations prevent old save completions from altering another open document. A lost response must reuse its operation ID and reconcile the prior receipt, not duplicate a mutation or creation.

Remaining boundaries are deliberate and must not be described as implemented: PDF general paragraph reflow, arbitrary font extension/nested forms, new reply threads/arbitrary markup creation, OCR, certified redaction/signing and general prompt-to-PDF composition; Writer multiple new section breaks without intermediate Save/reopen, picture watermarks and generic remote media analysis; Sheets attached-workbook merge; some desktop filesystem/session tools without browser counterparts. Imported unsupported Slides animation/geometry must not be destructively flattened. See the matrix for per-tool qualifications.

The local tested Fireworks lane was text-only. The accepted Word flow used a text arrow diagram. Native graphical serialization has fixture tests, but a successful visual-polish workflow on production Bedrock still needs live validation. Full Microsoft Word/Excel/PowerPoint compatibility has not been certified.

## 5. First follow-up: put JEV behind AgentCore

### Intended path and its current status

```text
Authenticated browser Office request
  -> application server: classify compact task state
  -> IAM/SigV4 AgentCore Gateway tools/call
  -> dedicated Lambda adapter target
  -> TypeSafe POST /v1/systemone using a server secret
  -> validated answer packet -> deterministic route policy
  -> production Bedrock reasoning stream -> typed native Office tools
```

This is the recommended implementation design, not a provisioned endpoint. AgentCore Gateway supports [Lambda targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html) and [IAM outbound authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html). A small Lambda target fits the existing application's IAM gateway pattern and keeps the vendor credential in the adapter. Gateway mediation does not make JEV an AWS-hosted Bedrock model: the approved compact state still goes to TypeSafe. AgentCore Runtime is a different component; only use it instead if its concrete deployment/latency requirements justify it. No extra generative agent is required just to call the classifier.

### Implementation sequence

1. Add an explicit server transport configuration and a testable interface around `systemOne`. Proposed names, **not existing environment variables**, are `TYPESAFE_TRANSPORT=agentcore|direct`, `TYPESAFE_AGENTCORE_GATEWAY_URL`, `TYPESAFE_AGENTCORE_TOOL`, `TYPESAFE_AGENTCORE_REGION`, and `TYPESAFE_AGENTCORE_PROTOCOL_VERSION`. Production must select AgentCore; direct vendor mode is allowed only in the guarded synthetic local lane after migration. Missing gateway config means conservative main-model fallback, never a hidden direct call.
2. Separate the shared question/answer validators from the transport. Keep the existing request/result shapes so Office and other TypeSafe callers retain behavior. `typesafeConfigured()` must become transport-aware; AgentCore configuration cannot depend on the app possessing `TYPESAFE_API_KEY`. Audit all callers with `rg -n 'systemOne|typesafeConfigured|TYPESAFE_' src infra scripts`.
3. Define one compact gateway tool for the complete question batch. Decide and document its exact schema, payload limit, model allowlist and timeout contract. Preserve `task_class`, `changes_document`, and `needs_legal_judgment` together in one request. Validate unsupported question/model inputs before vendor calls. Pass no credentials or arbitrary upstream URL in the tool arguments. A Lambda target receives the tool arguments directly as its event, not an API Gateway proxy request; return the agreed JSON object and validate the Gateway MCP wrapper on the client. Discover/pin the actual namespaced tool name from tools/list during provisioning.
4. Implement a small Lambda adapter with a fixed allowlisted TypeSafe HTTPS endpoint, `redirect: error`, bounded JSON body reading, strict output validation, sanitized error envelopes and cancellation/deadline handling. Resolve the secret through the adapter role's approved secret mechanism; use a bounded rotation-aware secret cache. Lambda timeout alone is too coarse for an 800 ms classification path. A disconnected caller does not prove a Lambda invocation was cancelled: enforce the remaining deadline inside the adapter as well.
5. Create the gateway target/schema and exact IAM policies through infrastructure code. Application role: invoke the intended Gateway. Gateway service role: invoke only the adapter function/alias. Adapter role: read only its intended secret plus necessary logging/KMS permissions. Do not reuse the web-search tool name, enable unauthenticated access, or broaden the existing search resource grant. Existing foundation parameters permit a single gateway ARN; account for a separate routing gateway explicitly if chosen. Wire runtime and selected environment parameters to real stack outputs. Keep ARNs and gateway IDs as parameters until provisioned.
6. Implement the server MCP adapter using `signedAwsFetch` and the `bedrock-agentcore` signing service with an explicit matching region. Restrict gateway URL/region/tool to configured approved values. Keep the deadline through body reading; do not copy the search client's header-only timer lifetime. Validate request IDs, HTTP errors, JSON-RPC errors, MCP `isError`, supported result envelopes and final TypeSafe answer types. See [Gateway tool calls](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html) and [inbound authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html). Inspect the gateway's actual supported protocol versions; the existing search client pins `2025-03-26`, which is not evidence about a new routing gateway. Do not blindly copy a newer protocol's headers into the old one or assume every response is ordinary JSON rather than SSE.
7. Preserve the end-to-end 800 ms classification budget initially, zero critical-path retries, pinned `jev-1.13.0`, bounded five-minute positive cache and five-second abstention cache. Include transport, endpoint/tool identity, model, rubric, request context and configuration in cache identity. Never cache cancellation as abstention. The budget includes signing/credential resolution, gateway, adapter, secret lookup, vendor and body parsing. Measure before changing it; cold starts cannot silently consume the reasoning budget. Timeouts/invalid answers select main Bedrock directly, with no second classifier hop or direct vendor bypass.
8. Move the production TypeSafe credential out of the application runtime when all shared callers have migrated. Update the present dynamic secret reference in `infra/app/app-runtime.cfn.yaml`, `.env.example` documentation and configuration tests. Do not delete a shared secret still used by another deployed consumer. Keep rollback capability through a prior deployment/config version; rollback must not silently restore direct production vendor egress.
9. Add transport/adapter/infrastructure tests and a synthetic staging probe. Required cases: no app vendor key; authorized IAM path; denied IAM; wrong tool/protocol/ID; malformed, truncated or oversized response; JSON-RPC and MCP errors; TypeSafe 401/429/5xx; secret failure/rotation; wrong model/options/probabilities; signing hang; body-read hang; abort before/during/after call; deadline exhaustion; no retries/direct fallback; cache isolation and recovery. Assert that untrusted gateway answers cannot grant write tools or change ownership.
10. Measure cold/warm p50/p95/p99, cache hits, fallback/abstention rate and disagreement on held-out synthetic tasks. Include numerical, ambiguous, legal, adversarial and multi-condition prompts. Compare full agent time to first useful action and completion, not just vendor time. Only broaden JEV routing after accuracy and end-to-end speed improve. Update the docs with actual resource identities and measured results after provisioning; never manufacture deployment evidence.

JEV supplies probabilistic decisions. Deterministic scheduling code validates their consistency and applies conservative gates. Use it for compact tier/task classification and independently useful routing hints; use reasoning models for actual writing, planning and tool argument generation. Do not call it for each cell, each style property or every unchanged tool round.

## 6. Run a disciplined task and repair loop

For each change, write a small acceptance contract: requested outcome, current document/revision, allowed scope, capabilities required, invariants to preserve, and observable success. Capture selection/page/object identities through the editor. A page number in prose or a stale screenshot is insufficient to delete content.

1. **Inspect:** read the smallest relevant native context and guide. Identify dependencies and output format. For “remove this highlighted section on page 2,” use the captured selection plus current document revision and exact expected text; if it is stale/ambiguous, reacquire the target before editing.
2. **Plan:** break complex work into checkpoints with success criteria. Independent read/inspect/formula-validation tasks can run with bounded concurrency. Schedule writes by document/revision and dependency; overlapping writes are serialized. Subagents return scoped findings/proposals, and a coordinator applies validated edits.
3. **Execute:** prefer bulk native operations over repeated model calls. Use formula engines and native style operations for exact work. Whole-body replacement must be explicit; preserve document page geometry unless the request changes it. Cancellation and navigation invalidate pending session ownership.
4. **Verify:** inspect changed native state immediately; check formulas/types/units, affected ranges, table dimensions, selected text boundaries, page counts and preserved relationships. For visual changes, inspect rendered output using an actually available vision-capable path. Never claim visual review with a text-only model.
5. **Repair:** return structured error details to the loop; diagnose schema, stale target, unsupported capability, provider failure or serialization problem. Re-read after stale/conflicting state. Retry only transient or proven replay-safe operations. Before retrying an ambiguous save/create, reconcile its immutable operation receipt. Repeated identical failures trigger a changed approach or an honest partial result, not an infinite loop.
6. **Checkpoint/compact:** preserve objective, user corrections, current revision, verified edits, unresolved errors, source provenance, completed receipts and next actions. Do not use summaries as evidence that tools ran. Retain configurable round/time/token limits and user cancellation; long tasks need progress detection and continuation, not unlimited retries.
7. **Deliver:** Save, confirm the exact server revision/hash, reload from Library, Download, parse the downloaded native file, and compare invariants. A toast, generated URL, screenshot or local Blob alone does not prove persisted delivery. PDF split/extract must create real separate Library artifacts and report partial receipts; the original stays unchanged.
8. **Report:** provide actual completed actions, verifications and remaining limitations. Unsupported completion claims must stay partial/unverified. Maintain the shared completion guard rather than allowing fluent claims to override tool evidence.

For engineering work, reproduce a defect before changing it, add a regression for the broken boundary, implement the smallest fix, rerun affected checks, then run the broader gate once before delivery. Parallelize independent editor tasks with disjoint file ownership. Avoid simultaneous edits to shared loop, inference, policy or persistence files.

## 7. Reproduce locally

Follow [local setup](office-local-development.md). The tested host used Node 24, Bun, Rust/MSVC and C++ build tools. Root dependencies use `bun.lock`; the Office service has its own npm lockfile. Native modules must be built for the host architecture. On Windows:

```powershell
bun install --frozen-lockfile --ignore-scripts
powershell -File scripts/setup-local-office.ps1
npm --prefix services/office-engine ci --ignore-scripts
npm --prefix services/office-engine run build
npm --prefix services/office-engine run build:native
# Set separately supplied provider credentials in this process only, per the local guide.
npm run dev:office:local
```

The local app uses port 5189, native engine 8790, DynamoDB Local 8180 and S3rver 4568, all loopback. The launcher supplies synthetic identity/dummy storage credentials and keeps data under ignored `.integration.local`. It does not require real AWS access. Use synthetic files only for external test providers. Without separately configured model credentials, pure unit/native tests still run, but live agent tests cannot establish model behavior.

When changing prompts, tools or loop callbacks, fully reload the page and start a fresh session before acceptance; development hot reload previously retained old closures. Keep an existing document available separately when intentionally testing conversation recovery.

## 8. Verification commands and acceptance matrix

From the repository root, without production credentials:

```sh
bun test src/lib src/writer/packages/agent-core
bun test src/writer/packages/ui/src/assistant-display.test.tsx
npm --prefix services/office-engine test
node --test scripts/lambda-native-target.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
node scripts/verify-pdf-build.mjs
git diff --check
```

This is broader than only the changed test file. `npm test` covers the first command; it does not include every extra gate listed here. The final implementation checkpoint recorded 1,070 pass / one opt-in integration skip / zero fail across 170 files, plus 28 native engine, six assistant rendering and four packaging-boundary tests. TypeScript, production-mode Windows build and isolated emitted PDF parser passed. Treat these as historical results; report fresh results for your own changed commit. The skipped integration test needs its documented local Dynamo setup, not fabricated success.

With the local stack running, use a second terminal and execute in order (the large-create probe consumes the large-save probe's generated file):

```powershell
$env:LOCAL_SYNTHETIC_MODE = '1'
node scripts/office-roundtrip-local.mjs
node scripts/verify-writer-large-save-local.mjs
node scripts/verify-large-create-local.mjs
```

| Acceptance | Required observation |
| --- | --- |
| Writer selection | Remove only the captured highlighted target on page 2; surrounding paragraphs, table XML, page break and unrelated parts survive. Save/reload/actual download match. |
| Writer clear/create | Explicitly clear a two-page body, create the requested one-page layout and native table; no inherited old paragraph breaks or indents. |
| Writer tables/diagrams | Many repetitive tables, embedded images, editable chart + embedded workbook; direct and staged paths; no lost relationships, unsaved edits or false download receipts. |
| Large persistence failures | Dropped commit acknowledgement, full retry after stage cleanup, stale revision, tampered hash/size, cross-owner/doc token, cancellation and document switching. No duplicate versions/artifacts. |
| Sheets long task | Synthetic Tesla 20-quarter workbook with formulas, multiple sheets and charts; multi-round continuation, corrections and formatting; independently recalculate and validate native chart axes/relationships. Synthetic figures are not reported Tesla earnings. |
| Sheets narrow edit | Modify only an identified range; preserve all other formulas, styles, charts, names and workbook parts. |
| Slides | Exercise the eleven added operations with native export/reopen; verify layouts, connectors, OfficeMath, animations, geometry and tables. Refuse unsupported imported graphs without destroying them. |
| PDF source edit | Native source text/image inspection, exact targets/current revision, font-glyph limits, correct opacity raster, page boxes and annotations; save/reopen and independently extract. |
| PDF derivative delivery | Extract/split into actual Library files; retry/partial failure produces stable receipts; source unchanged; authenticated download bytes verified. |
| Loop and UI | Long continuation, tool error repair, ordered writes, parallel independent reads, queued user direction, stop/abort, navigation, stale callback, failed save and unsupported completion. |
| AWS staging | Signed Bedrock tools, actual model/profile access, AgentCore-mediated JEV, auth/ownership, real S3 signed PUT CORS/checksum, conditional revision updates, native engine and fresh-session browser flows. |
| Desktop interoperability | Open, edit, save and reopen representative DOCX/XLSX/PPTX in actual Word/Excel/PowerPoint; inspect PDF in independent readers. No repair dialogs; inspect pagination, layout, formulas, charts, links, notes and exported bytes. |

Five small synthetic acceptance outputs are included under [samples/office-acceptance](../samples/office-acceptance/README.md) with hashes. They are portable review files, not replacements for rerunning tests. Generated 7.5 MB fixtures, logs, patches, emulator databases and provider keys are deliberately not versioned; the scripts regenerate large fixtures.

## 9. Release and next-work priority

1. Implement/test the AgentCore transport and adapter contract locally with injected transports. Prepare parameterized infrastructure without assuming an existing routing endpoint. This is the first outstanding architecture task.
2. Rerun the regression matrix on the external agent's host and verify native acceptance in Microsoft applications. Address demonstrated fidelity failures before expanding advertised parity. Prioritize Writer multi-section support and remaining PDF native limits according to measured user impact.
3. Obtain the intended AWS environment access separately. Read-only identity/config inspection precedes deployment planning. Use the configured profile as one token: `AdministratorAccess-475976462949`. Do not infer live resources from placeholders or conflate testing with the separate production account.
4. For an authorized release, follow the repository runbook and verify actual parameters. Build/install/package on matching Linux/glibc architecture (checked-in testing uses arm64), not by uploading a Windows preview build. Include PDF worker/WASM/licensing, native engine dependencies, staged-upload lifecycle/CORS, and Gateway/adapter IAM and secret configuration.
5. Stage with synthetic fixtures and collect real Bedrock/JEV timings and failure recovery. Keep local synthetic/provider flags and temporary keys out of AWS runtime. Confirm browser assets and server are from the same commit. Carry out actual authenticated saves, reloads and downloads.
6. Promote only the tested artifact/config pair through the environment's release process. Record commit, artifact hashes, target account/region, parameter version, model IDs, gateway tool/protocol identity and rollback artifact. Rollback preserves saved document revisions; it never deletes user data to make a test pass.
7. Finish with changed files/behavior, commands and results, measured latency, remaining unsupported capabilities, and deployment status. Update the parity matrix and evidence docs. Never label the branch “full parity” or “AWS verified” based on tool counts/local tests alone.

Suggested kickoff instruction: “Read EXTERNAL_AGENT_START_HERE.md and this handoff; reproduce the existing baseline; implement the AgentCore-mediated TypeSafe transport with strict deadline, IAM, schema and fallback tests; preserve Bedrock production reasoning and native Office delivery; then run the acceptance loop and report measured results. Do not integrate new research services or deploy AWS resources as part of repository setup.”
