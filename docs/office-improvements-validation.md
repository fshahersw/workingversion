# Office and PDF improvements: implementation and release evidence

Prepared September 21, 2026. Branch: `codex/office-pdf-quality`, based on `e595931af932953a0f3ef70e9cfb80a837c001bc`. This is a locally implemented and tested release candidate. AWS access was deferred by the user; it has not been deployed or verified against the running firm environment.

The initial validation ran at `http://127.0.0.1:5189/office` with the real Office engine, DynamoDB Local, local S3-compatible storage, synthetic identity, and direct Anthropic inference. JEV was enabled explicitly. The subsequent [complex-workflow validation](office-complex-workflow-validation.md) records the Fireworks fallback, longer live Sheets task, additional export defects and fixes. See [the local runbook](office-local-development.md).

## What changed

| Area | Implemented behavior | Why it matters |
| --- | --- | --- |
| Writer accuracy | Original instructions govern verification; existing style warnings are advisory. Automatic repair targets newly introduced structural damage. Narrow edits preserve unrelated content and styles. | A request to change one heading no longer triggers cover-page additions or unrelated restyling. |
| Writer rollback | A failed task restores its snapshot only while it owns the mutation chain. Interleaved manual or ambiguous asynchronous edits are preserved for review. | Avoids overwriting user work while recovering from a failed agent run. |
| Sheets and Slides | RPC queues bind to the originating document/session generation. Navigation aborts old requests, rejects queued stale edits, and ignores late responses. Worker opens and cleanup have explicit ownership. | An old response cannot be applied to the next document. |
| Sheets persistence | Pending edits finish before rollback, rollback finishes before save, and busy state persists until finalization. Incomplete rollback pauses autosave. | Avoids saving partially reverted files. |
| Sheets formulas and reads | Read bounds include unsaved cells and fills. For fully loaded automatic-calculation workbooks, save waits for completed calculation and exports raw scalar formula results separately from formulas. Session/journal changes abort stale saves. | Newly created ranges can be verified immediately, and supported formulas retain both their formula and current cached result in native XLSX downloads. |
| Slides precision | Native bounded inserts work on an existing blank slide. Tool schemas name the canonical operation. Automatic layout checks are read-only; explicit polishing stays in the user-scoped task. | A requested 24-point box at an exact position stays there instead of being enlarged and centered by a second model pass. |
| Chat persistence | Atomic DynamoDB transactions allocate sequence numbers and persist messages with payload-checked idempotency records. Browser append queues retain operation IDs on retries. | Parallel messages and retries no longer overwrite or duplicate each other. |
| Agent panel | Readable activity, parallel counts, duration, tool previews, safe citations, workspace links and expandable technical details. Malformed display payloads cannot crash the conversation. | Shows useful evidence without exposing opaque provider reasoning or raw technical output by default. |
| Model transport | Local-only Anthropic/Fireworks adapters implement complete streaming/tool-call validation, cancellation and provider-bound reasoning replay. Production stays on Bedrock. | Exercises the real agent protocol locally without substituting direct-provider credentials into AWS configuration. |
| JEV routing | One bounded request evaluates task class, document mutation and legal judgment. Full instructions and context influence routing; cache keys include policy version. Ambiguous, risky or failed classifications keep the main model. | Reduces unnecessary reasoning-model routing work without allowing JEV to authorize tools or execute edits. |
| PDF workspace | Office tab/page, page rendering and text selection, page-cited read/search, visual capture, native notes/highlights, bounded new text, supported form edits, rotate/reorder/delete, undo, immutable save and download. | Adds an actual editable PDF workflow, with executable tools and native PDF output. |
| PDF parsing | PDF.js follows the real page tree and decodes compressed/hex text. Structural restrictions guard unsupported editing cases. | Fixes extraction based on physical object order and simplistic text parsing. |
| Deployment packaging | Lambda build/package/deploy guards check the configured Linux architecture, emitted PDF dependencies, actual native binary headers and build metadata. | Prevents a successful Windows preview build from being uploaded as a Linux Lambda artifact. |

The upstream [GenOffice source](https://github.com/genspark-ai/genoffice/tree/476e5023c9a4bc459ca6de7b1d697ab25d94850e) review informed the native-file strategy, typed tool contracts, focused editing, read/verify loops and shared activity presentation. Existing integrated engines were retained. The new PDF workspace does not copy GenOffice's desktop-only PDF implementation; its PDF.js text-layer CSS attribution and license are preserved in `src/office/pdf`. JEV work follows the [official TypeSafe documentation](https://docs.typesafe.ai/introduction); the requested [awesome-jev repository](https://github.com/yibie/awesome-jev) was used as a discovery index, not an authority for API guarantees.

## What was actually verified

The combined regression run passed **855 tests, with one opt-in integration test skipped and zero failures** across 138 files. The skipped test was separately run successfully against official DynamoDB Local. TypeScript passed. Four additional Lambda target/packaging boundary tests passed. The production-mode Vite build and isolated emitted PDF parser check passed on Windows/x64. The isolated check copied only emitted dependencies into a temporary directory and correctly extracted a two-page fixture whose physical object order differs from page order. A local build is not an AWS runtime test.

| Evidence | Actual result |
| --- | --- |
| Writer, real browser agent and downloaded DOCX | Requested only `Test facts` Heading 2 → Heading 1. Revision 3 changed only that paragraph style; all other document XML matched after normalizing that single intended change. Five other package parts were byte-identical. The table, total and text were preserved. |
| Sheets, real API/JWT/native engine/save/download/reopen | Numeric edit and new formula/cached value survived; existing formula, number format and fill survived. Revision/hash verified. Six of nine original ZIP parts identical; only worksheet, styles and workbook calculation metadata changed. |
| Slides, real API/JWT/native engine/save/download/reopen | Editable text, 24pt font, bold, color and two-slide count survived. Revision/hash verified. Twelve of thirteen ZIP parts identical; only the target slide changed. |
| Sheets, actual browser agent acceptance | Fresh workbook: exactly A1:B4 with Item/Amount, Alpha/12, Beta/13, Total/`SUM(B2:B3)`. Two actions completed without failed tools. Downloaded revision 2 contains both `<f>SUM(B2:B3)</f>` and `<v>25</v>`, exactly eight cells, only A1/B1 bold and B2:B4 currency. |
| Slides, actual browser agent acceptance | Five actions completed without failed tools. Downloaded revision 2 contains exactly one editable text shape, `Synthetic slide quality check`, x/y 914400 EMU, width 6400800 and height 914400 EMU (1,1 inches; 7×1 inches), 24pt bold #172E4C. One slide; original 12192000×6858000 EMU canvas preserved. |
| Native Office engine suite | Seven tests passed, including package-preservation fixtures. |
| Chat concurrency | Twelve distinct concurrent appends plus two duplicate retries produced exactly twelve new messages and twelve operation records. Legacy sequence 7 advanced contiguously through 19. Changed-payload replay and wrong-owner writes were rejected. |
| Lifecycle and rollback | Actual transformed Sheets/Slides host modules were tested for navigation during an RPC, stale queued edits/responses and delayed cleanup. Deferred rollback tests prove save waits; incomplete rollback does not save. |
| PDF, real browser agent/save/reload/download | The agent added `Synthetic PDF quality check` at (60,700), size 18, and a native note `Verify the original source` at (60,650). Independent PDF.js/pdf-lib checks found the exact text, note and coordinates, unchanged 612×792 page geometry, revision 2 and matching SHA-256. Immutable revision 1 stayed blank. |
| PDF fixtures | Twelve tests cover real page order, encoded text, forms, atomic failure, inherited resources, active-content restrictions, crop bounds, stale revisions, cancellation and missing text. |
| Local isolation | Loopback-only listeners, same-origin synthetic authentication, explicit local provider configuration, dummy storage credentials and refusal in hosted environments. Tests establish AWS-client rejection before construction/request and cached-client reuse. |

The browser PDF test first exposed an underspecified operation schema. Exact discriminated schemas fixed the failure, and the subsequent agent mutation and native-file checks passed. Independent review also found inherited page-resource loss, indirect unsafe-action names and invisible crop-bound edits; regression fixtures now cover those fixes.

Additional real browser-agent checks found two gaps that the initial direct-engine fixtures did not exercise. Sheets initially saved the formula without its cached result and used original-file range bounds after adding cells. Slides initially rejected a supported native insertion, fell back to a redesign, then a generic quality pass changed the requested 24pt box to 40pt. The fixes above were followed by fresh browser tasks and independent native ZIP/XML verification. Seven Sheets save/read regressions cover stale calculation/session/edit failures; six Slides regressions prove exact insert behavior and that automatic checks have no model or mutation authority.

## Measured routing and provider behavior

Direct synthetic provider probes used verified available model IDs: Anthropic `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`; Fireworks `accounts/fireworks/models/kimi-k2p6` and `accounts/fireworks/models/glm-5p3-flash`. These are development settings, not automatic Bedrock ID mappings.

With JEV active, an explicit pair of independent reads routed to the fast tier and produced two distinct tool calls in one response. Anthropic completed that turn in 1,365 ms and the read-result follow-up in 792 ms. Fireworks completed them in 1,094 ms and 912 ms. Exact-format proposals took 894 ms and 1,648 ms respectively. These were protocol probes; their tool proposals were not executed against a document. After restarting the actual local app with JEV enabled, the HTTP endpoint repeated this successfully: two read calls on Haiku in 1,915 ms, correct follow-up in 762 ms, format proposal in 928 ms, and edit-result follow-up in 819 ms. Mixed legal analysis stayed on Sonnet; ask-mode write tools remained forbidden.

A mixed formatting/legal-analysis request stayed on the main tier. Anthropic completed its small synthetic turn in 2,990 ms. Fireworks' Kimi main-tier sample timed out at 60,017 ms; it is not counted as successful. Anthropic was the local primary provider for this initial validation. Cancellation probes stopped before returning a tool; an HTTP ask-mode request offering a write tool was rejected with 403 before inference.

An initial JEV rubric confused a chat summary with changing the file. A predefined 12-case A/B check evaluated summary, explanation, table analysis, explicit writes, footnotes, legal judgment and mixed requests. Revised wording improved mutation labels from 11/12 to 12/12 and simple-read fast routing from 3/4 to 4/4. Both variants had zero observed unsafe write or main-required downroutes. Thresholds stayed unchanged; the routing cache version changed. All 24 requests finished within the 800 ms budget. Revised median was 146 ms and p90 311 ms; the older p90 was 193 ms. This small sample supports the wording change, not a general accuracy or latency claim.

Existing read parallelism and multi-call support were preserved. Mutations remain ordered and revision checked. This change does not add a durable multi-document autonomous scheduler, cross-tab leases, or JEV semantic branches to the separate Workflows graph engine.

## Production Bedrock configuration and safe release sequence

Production inference still uses the existing Bedrock Converse transport and `OFFICE_MODEL` / `WRITER_BEDROCK_MODEL`, `OFFICE_FAST_MODEL`, `OFFICE_THOROUGH_MODEL` and optional inspect-tier configuration. Existing deployment model IDs were not silently replaced with direct Anthropic IDs. Confirm the configured model/profile IDs, region access and IAM in the intended AWS account before release. JEV remains an external server-side routing service; disabling or failing it must preserve a correct main-model path.

1. Restore read-only access to account `475976462949`. Compare live Lambda versions/configuration, CloudFront origins, Office ECS image digest, secret bindings, DynamoDB/S3 settings and current logs to the repository map. Inventory only; do not deploy from an assumed snapshot.
2. Build in a matching **Linux/glibc arm64** runner for the current testing architecture. Install native dependencies there. Run the controlled Lambda build and isolated emitted PDF parser probe, then package. Windows preview output is intentionally rejected. No matching Linux runner was available locally during this work.
3. Run AWS staging protocol tests with synthetic documents: Bedrock streaming, JEV timeout/fallback, ask/write tool policies, session switching, concurrent saves, rollback, cancellation, reconnect and native downloads. Measure user-visible first text, completed tool latency and total task duration separately.
4. Validate an independent Office/PDF corpus in actual Word, Excel, PowerPoint and a separate PDF viewer. Compare renderings and semantic contents before and after narrow edits. Include tables, pagination, numbering, citations, charts, formulas, pivots, comments, tracked changes, fonts and embedded objects.
5. Use a small explicit canary after those gates. Record app version, engine image digest, routing policy and configuration; monitor failure/fallback rates, lost-save indicators, file validation and p50/p95/p99 timing. Retain prior Lambda/engine artifacts and immutable document revisions for rollback. Do not roll out based only on these synthetic timing samples.

No AWS resources were mutated, no live firm documents were accessed, and no commit was pushed. Temporary provider keys are process-only and absent from deliverable files.

## Remaining capability boundaries

- Native DOCX/XLSX/PPTX checks establish covered fixture preservation, not universal Microsoft Office compatibility. Actual Microsoft desktop application acceptance remains open.
- Formula caches are populated only when the loaded workbook has complete precedents and calculation finishes successfully. Unsupported/nonfinite results and manual/incomplete calculation are not presented as verified values. Excel recalculation and advanced-function compatibility remain corpus-validation gates.
- PDF supports native annotations/forms/page changes/new text, not existing-text reflow, permanent redaction, digital signing, OCR, merge, Office-to-PDF conversion or arbitrary font embedding. Signed/encrypted/active-content/XFA documents are refused. Reorder/delete is conservative around links, tags, labels and forms.
- PDF extraction has bounded size/page/text/deadline limits but is not hard process isolation against hostile decompression/CPU use. Parser isolation and adversarial corpus testing remain release-hardening work.
- Office tasks remain browser-owned. Existing one-worker-per-owner/document behavior can replace another tab's engine session. This change prevents stale local lifecycle contamination; it does not implement durable cross-tab coordination.
- An RPC already accepted by the engine may finish against its original document after navigation. It cannot be redirected to the next document. Durable operation cancellation/recovery is separate work.
- The unrelated legacy allowlist entry `slides:read-slide` lacks a native handler. Verified flows use `slides:get-render-slides`; no new capability claim relies on the stale entry.

## Reproducing the evidence

See `docs/office-local-development.md` for the stack. Run the combined Bun suite, TypeScript, `npm run build`, `node scripts/verify-pdf-build.mjs`, and `node --test scripts/lambda-native-target.test.mjs`. Local document checks live in `scripts/office-roundtrip-local.mjs`, `scripts/verify-writer-roundtrip-local.mjs`, `scripts/verify-browser-office-local.mjs` and `scripts/verify-local-pdf.mjs`. The real Dynamo concurrency test has an explicit local-only opt-in header.

The task workspace also contains the original comprehensive source/configuration map, GenOffice/JEV research and sanitized runtime evidence in the sibling `analysis` directory. That original audit describes the pinned baseline; this report describes the implemented changes.
