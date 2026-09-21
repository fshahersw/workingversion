# PDF workspace and production Office follow-up

Validated September 21, 2026 against local synthetic documents. Production inference remains AWS Bedrock; this pass did not access AWS, change deployed resources or push a branch.

## Implemented behavior

The PDF workspace now uses the shared Office assistant components: readable responses, collapsible tool activity, Edit/Ask/Review modes, Standard/Thorough depth, queued directions, cancellation, context and a resizable panel. Ask/Review filter mutation tools and enforce the restriction again at execution. Current page and selected text reach the agent as document evidence. Starter prompts describe supported operations.

The document UI adds lazy page thumbnails, fit-width zoom, source-text search, a review/organization/forms ribbon, click-to-place notes and new text, annotation inspection/edit/removal, native field controls, page rotation/reordering/deletion, Undo, Save and PDF download. Page placement uses PDF.js inverse viewport coordinates, including rotation/crop transforms. Manual edits, save and agent startup share synchronous collision guards in addition to revision checks. Search discards stale results after document changes. Annotation parsing occurs only when its sidebar is opened.

Native annotation handling supports bounded pagination and safe note/text-markup updates. Locked, threaded, shared and oversized comments are protected; truncated text is never offered for destructive replacement. Matching popups are removed only when ownership is safe. The UI indicates when its displayed annotation subset is incomplete; the agent can request subsequent pages.

Bedrock stream completion and JEV timeout handling are described in [production routing validation](office-routing-production-validation.md). The complete upstream tool inventory, working equivalents and missing native ports are in [GenOffice parity](genoffice-tool-parity.md). The new shared workflow guide covers staged execution, independent reads, ordered mutations, verification, repair and native exports. Sheets export guidance now distinguishes a values-only derivative from the full saved workbook. Unsupported template capture is no longer advertised by editors without a capture hook.

## Observed browser and native-file checks

The real local PDF workspace loaded the saved synthetic one-page file with existing text and a native note. Through the UI:

1. Edited the existing note to `Verified synthetic source note — reviewed in the PDF workspace.` and saved revision 3.
2. In Ask/Thorough mode, requested exact note and page-text verification. The configured Fireworks model used two native read tools, quoted both actual contents and completed without document changes. This verifies the local transport; it is not a live Bedrock test.
3. Added `Synthetic click-placement verification` by clicking the displayed page, removed it, restored it with Undo and saved revision 4. The saved PDF contains both native annotations. The placed note begins at PDF coordinates approximately `[320.247, 569.220]`, corresponding to the observed page click.
4. Independently reopened the stored bytes using pdf-lib and PDF.js. Exact original text, its `[60,700]` position and 18pt size, the existing note's `[60,650]` position, the Letter page box and original immutable revision were preserved. The revision hash matches the actual bytes: `dadd67cf558eccd11f0967ca068c880d3f915005d507099648d3bc9cc84011be`.

The task deliverables include `pdf-workspace-review.pdf`, `pdf-workspace-validation.json` and `pdf-ui-native-validation.json`. A browser automation download event was not observed after clicking Download PDF in the in-app browser; native saved/exported bytes were retrieved and verified separately. Browser download-manager acceptance remains an explicit check, not a claimed pass.

## Verification and limits

The main regression suite passed **1,010 tests**, with one local Dynamo integration test skipped and zero failures. The focused PDF tests cover native annotation preservation, shared popup relationships, read-only enforcement, revision changes, interrupted-run recovery, queued directions, dynamic mode/profile forwarding and same-tick UI collisions. Bedrock tests exercise the actual production parser with synthetic fragmented AWS event frames; no AWS credentials or network calls are used. Shared assistant display tests, TypeScript, the production build and emitted PDF parser isolation are checked separately in the delivery evidence.

This is not complete upstream parity. Newer Writer operations, eleven Slides operation names and much of the PDFium editing surface require further native implementations. PDF existing-text reflow, OCR, permanent redaction, signing, image editing, merge/split and Office conversion remain unavailable. Files are not certified against Microsoft desktop applications. Interactive tasks remain bounded and browser-owned; durable background execution and cross-tab coordination are separate work. AWS release still requires the staging checks in the [initial implementation report](office-improvements-validation.md).
