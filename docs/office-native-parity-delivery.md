# Office native tool expansion and delivery validation

This change follows `d872448f8d63` on `codex/office-pdf-quality`. The public platform baseline is `e595931af932`; the inspected GenOffice reference is `476e5023c9a4bc459ca6de7b1d697ab25d94850e`. All live tests used synthetic documents, loopback storage and the explicitly configured temporary Fireworks/JEV lane. No AWS resources, deployed models, production data or hosted application were changed.

## Result

- Writer adds 17 native browser tools and 23 atomic operation types: exact selected-text replacement, explicit whole-body replacement, native comments/notes/revision selection, named styles, section breaks and floating objects. Whole-body replacement no longer inherits old paragraph page breaks. Scoped edits continue to preserve surrounding formatting and content.
- Slides implements the eleven missing native operation names, reaching all 61 documented upstream names. New support includes real layouts, attached connectors, arrangement, OfficeMath, native animations/custom geometry and table styles. Unsupported imported animation graphs and geometry are refused rather than destructively flattened.
- Sheets retains all 55 upstream operation names (58 local), native formulas/charts and the earlier long-task repairs. The earlier synthetic Tesla workbook acceptance exercised 35 rounds plus a 16-round correction, with 515 financial checks and 4,434 preservation checks. This turn does not claim a new live Sheets run.
- PDF gains a pinned self-hosted PDFium worker, actual source text/image edits, persistent editable inserted text, native page operations, local source attachments, outline/navigation and extraction/split. Extracted files are saved separately in the Library, then offered through authenticated download links. Partial export failures report completed files; same-workspace retries reuse them.
- Agent modes and browser/server/native allowlists stay aligned. Independent reads can run concurrently; document writes retain ordering, schema validation and revision/ownership guards. No new research service was integrated.

See the per-tool [parity matrix](./genoffice-tool-parity.md), [Writer evidence](./writer-native-parity-validation.md), [Slides evidence](./slides-native-parity-validation.md), and [PDF evidence](./pdf-native-parity-validation.md). Operation-name coverage does not establish identical optional fields or universal Office fidelity.

## Writer Save/Download failure fixes

The archive validator rejected legitimate repetitive table XML for exceeding its compression-ratio heuristic. XML/relationship parts now use absolute inflated-part/aggregate limits, CRC, actual-size and native XML validation instead; non-XML ratio checks remain. A 3,000-row/four-column native table regression passes, while oversized XML remains rejected.

Files over 3 MiB now upload directly to owner-bound S3 staging URLs and commit using a small authenticated JSON request. This avoids sending base64-expanded large files through Lambda's synchronous payload boundary. The server binds document, owner, expected revision, operation ID, byte length and SHA256; the normal native validation and conditional revision save remain authoritative. Engine JWTs stay scoped to the current document and never reach S3. Successful commits remove staging bytes; infrastructure adds one-day expiry for abandoned uploads.

Lost save acknowledgements are reconciled against immutable operation receipts before reading deleted staging objects. Native engine retries reuse the same operation identity. Large creation/Save As likewise keeps a stable creation identity across failed or malformed responses. Word Save/Download calls coalesce, capture their owning session, and cannot apply stale bytes or completion events to another document.

Downloads keep a real user-clickable fallback outside the assistant controls. Normal PDF Download saves dirty bytes first and downloads that exact server revision. A failed save offers explicitly labeled unsaved recovery bytes, never an old server revision disguised as the current edit.

## Acceptance evidence

| Check | Observed result |
|---|---|
| Final full regression suite | 1,070 passed, one opt-in Dynamo integration test skipped, zero failed; 170 files. Includes PDF derivative delivery, partial-export receipts, deterministic extracted bytes and unsupported-completion guards. |
| Native Office engine | 28 tests passed, including all eleven new Slides operations and ambiguous-save replay/retry. |
| Shared assistant rendering | Six tests passed. |
| TypeScript / production-mode build | Passed on Windows; the build emits both the local PDFium worker and WASM. The final source was checked again after the download and response-verification fixes. |
| Emitted server PDF parser | Isolated emitted-dependency probe extracted the two-page fixture successfully. |
| Lambda architecture/package boundaries | Four tests passed; Windows artifacts are refused as Linux Lambda deployment packages. |
| Large Word revision and creation | A 7,515,642-byte real DOCX with 24 tables and 24 images passed staging, native validation, immutable save, full retry, direct reload and exact-hash download. Tampered commits and unauthorized creation were rejected. |
| Native chart/table preservation | A targeted Word edit preserved 24 tables plus real editable chart XML, relationships and embedded XLSX byte for byte. |
| Live selected text | The agent removed only `REMOVE THIS ONLY.` on page 2. Surrounding text, native table and page break stayed intact; 16 other package parts were unchanged. Save and actual browser download succeeded. |
| Live clear/create | From a fresh two-page source, whole-body replacement produced one page immediately, with the requested four-row native table and centered text flow. Three tool actions, one mutation, clean audit; native save and actual browser download succeeded. |
| Live PDF source edit | Original text became `Synthetic PDF native edit verified`; page box remained 612×792 and both notes were preserved. Revision 5 reopened correctly; independent extraction and actual browser download passed. |
| Live PDF extraction | One actual tool call created Library document `01M32ZC2SHYD49P8XZH9PAFAF4`, revision 1, 1,155 bytes. Text, page box and both notes matched; the original revision/hash stayed unchanged and the visible link produced an actual browser download. |

The local Fireworks configuration is text-only. It correctly reports unavailable visual/graphical tools; the live Word flow therefore used a text arrow diagram. Native diagram/image/chart serialization has focused fixture coverage, but this is not evidence of a production Bedrock visual-polish run. A development session retained an old agent callback through hot reload; fresh-session acceptance above verifies the corrected implementation. The PDF test also caught a model inventing an export receipt without a tool call. PDF completion checks now request a correction for unsupported export claims or fabricated download URLs; the shared loop suppresses a repeatedly unsupported final claim and marks the result unverified after one correction. This is a bounded claim check, not a general semantic truth verifier.

## JEV and AWS production path

JEV evaluates three compact routing questions in one request with an 800 ms budget, pinned model, bounded cache and conservative fallback. Observed local JEV calls for the final Writer/PDF fixtures took 338 ms and 416 ms; these are individual observations, not a latency guarantee. It selects the reasoning tier; code owns permissions, exact targets, formulas, validation and write ordering. JEV is probabilistic classification, not a deterministic calculator or an unrestricted autonomous subagent. The production reasoning transport remains signed Bedrock ConverseStream; temporary direct-provider IDs are not remapped into Bedrock IDs. See [routing validation](./office-routing-production-validation.md).

Before release, run the controlled build in the configured Linux/glibc architecture, package the native engine, and verify the intended AWS account's model/profile access, secret configuration, IAM, signed S3 CORS/checksum uploads, revision concurrency and cancellation. Test representative real Word/Excel/PowerPoint/PDF files in the actual desktop applications. These checks remain outstanding because AWS configuration was deferred.

## Explicit remaining parity boundaries

General PDF paragraph reflow, complex font extension/nested forms, new reply threads, arbitrary markup creation, OCR, certified redaction/signing and general PDF composition from a prompt are absent. Writer multiple new section breaks require intervening Save/reopen; picture watermarks and generic remote-media analysis remain limited. Sheets attached-workbook merge is still filtered. Some desktop/CLI filesystem/session tools have no browser equivalent. External research/image services were not added. Native fixtures prove the stated cases, not exact rendering of every Microsoft Office file.

## Repeatable checks

Run the main Bun suite, shared assistant display tests, TypeScript, `npm run build`, `node scripts/verify-pdf-build.mjs`, `node --test scripts/lambda-native-target.test.mjs`, and the Office engine test script. `scripts/audit-genoffice-tools.mjs ../references/genoffice` regenerates the source inventory. With explicitly enabled local synthetic mode, `scripts/verify-writer-large-save-local.mjs` and `scripts/verify-large-create-local.mjs` exercise large-file delivery. None deploys the application.
