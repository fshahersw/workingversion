# Office agent reliability implementation

Scope: the real Seeger Weiss platform, Writer / Sheets / Slides. This increment implements the reliability and document-access work. It does not import MCO code or change deployment state. Preserve the pre-existing Discovery changes on this branch.

## Implemented behavior

- Writer literal replacements and matched styling span formatting runs and work inside table cells. They stop at paragraph/cell boundaries, protected objects, hard breaks and deleted revisions. Replacement text inherits the first matched run's marks; styling preserves each run's other attributes. `expectedOccurrences` aborts the entire command envelope on a mismatch. Existing transaction history and tracked-change dispatch remain in place.
- `read_document_outline` pages every top-level block. `search_document` searches editable text across the complete current document and returns exact positions and excerpts. Continuation uses a revision token and rejects stale pages after an edit. Structure previews and literal scans explicitly do not claim a complete semantic or visual review. `read_blocks` still supplies full content in bounded slices.
- Office native extraction includes Word body/table paragraphs, footnotes, endnotes, comments, headers and footers; Excel sheets/rows/cells, hidden sheets and formulas with available cached values; PowerPoint text, groups, tables, chart values and speaker notes. It excludes deleted Word revisions. Images and embedded objects need separate review. RTF and legacy XLS depend on the sandbox's parser packages; a missing parser is an error, never raw bytes presented as extracted text.
- The complete extraction is stored as bounded pages under a versioned, authenticated-owner prefix. All pages must persist before the manifest is published. The browser verifies page sequence, count and final character length. There is no silent 2-million-character truncation. The explicit extracted-text ceiling is 50 million UTF-16 characters. PDF OCR remains BDA and may contain recognition errors.
- Files up to 3.5 MB use the existing inline upload; 3.5–25 MB use checksum-bound direct S3 uploads. Size and checksum are verified before extraction. OCR handles are checked against an owner-specific job record and exact expected output prefix. The old shared extraction cache is not reused.
- `load_attachment_for_python` stages the original, owned attachment into the current Office task. Source handles are returned with attachment reads. Python binary writes are chunked; the result supplies the actual filename. Local plain text can be passed directly as data.
- Python state and artifact bookkeeping are scoped to authenticated owner and Office task. The integration now hydrates the session from DynamoDB for every Office operation, with conditional ownership around complete write/run/collect operations. Different tasks remain independent. Ambiguous operations are blocked, never automatically replayed; completed Python errors can be corrected in the same session. Expired sessions report loss of context explicitly. New Office requests begin fresh tasks. See [the integration handoff](discovery-office-integration.md) for durability, timeout and staging limits.
- Other Research callers of the shared interpreter are isolated by authenticated owner, but continue using their existing per-owner workspace. Research conversation-level isolation is separate work. Auth behavior and permissions are unchanged; the auth middleware only attaches verified identity to async interpreter context. There is no unauthenticated fallback.
- Independent agent reads run with concurrency four and retain tool-call result order. Pending tools check cancellation before starting. Mutations remain sequential.
- Ordinary Office authority searches have no date floor or automatic current-date anchor. Explicit recency requests retain the existing fresh-search policy. Other Research date policy is unchanged. Citation lookup distinguishes existence from quotation accuracy, pin cites, validity and Bluebook compliance.
- Mermaid/DOT source and rendering settings are retained with image handles for the current browser session; `get_diagram_source` enables iterative revisions. Mermaid SVG is retained alongside PNG. This is not persistence of editable diagrams inside saved DOCX/PPTX files.

## Important integration boundaries

- All Office RPCs continue through `requireAuth`. An untrusted tool `taskId` only selects a scope beneath the verified Cognito principal; it cannot select another owner.
- `require-auth.ts` and `start.ts` install async owner context because the interpreter is also used by authenticated Research routes. Keep this wiring if moving the interpreter. Public routes and worker processes need their own explicit trusted identity context before calling it.
- Browser tools do not receive AWS credentials. Original files, extraction manifests and OCR job records are under `office-attachments/v2/<owner hash>/`.
- Large direct uploads require the bucket CORS policy to include the app origin and permit PUT plus the checksum header. The existing testing CORS file has been extended for localhost:5176 and 127.0.0.1:5176; no cloud policy was applied.
- Python and BDA remain real AWS integrations. Local tests use actual document parsing fixtures and isolated state tests, without live model/OCR calls. Do not use an unrelated default AWS account to test this branch.

## Verification commands

```sh
npm test
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/@playwright/test/cli.js test --config playwright.office.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.discovery.config.ts
node node_modules/vite/bin/vite.js build
```

The Office browser fixture uses the production Writer command engine and real Mermaid rendering. The Python fixture tests run the generated extractor on actual DOCX packages and workbook/presentation fixtures. Harnesses are test-only pages, not authentication bypasses.

## Subsequent delivery

The Nova Sonic companion is implemented separately and defaults to disabled until staging verification. Durable background jobs and document-version conflict handling remain separate work. Docling, AntV Infographic and other new visual/parser dependencies are researched options, not installed production capabilities. Durable diagram source and worker-based large native extraction remain follow-up work. Office cross-instance session routing is now implemented and locally tested; actual multi-Lambda verification is still required.

## Historical validation results (before integration)

The current branch's evidence and release gates are in [the integration handoff](discovery-office-integration.md). The results below describe the earlier local increment.

Completed locally on 2026-09-12:

- 453 unit tests passed (including actual DOCX/XLSX/PPTX extraction and UTF-8 paging fixtures).
- 5 Office browser tests passed, using production editing commands, transaction Undo and Mermaid rendering.
- All 11 existing Discovery browser regression tests passed.
- Full TypeScript check passed. ESLint on 37 changed TypeScript files passed with zero errors or warnings. Git whitespace checks passed.
- Production Vite/Nitro build passed. Existing large Office bundle sizes remain a separate performance concern; no bundle-size or latency improvement is claimed from these checks.
- Dev remains available at http://localhost:5176/office with the normal authentication flow; the local auth endpoint returned HTTP 200.

No live AWS model, OCR, S3 or interpreter calls were made during validation. A test with the correct authenticated AWS environment, including direct-upload CORS and multi-instance Python continuity, is required before deployment. No push or deployment was performed.

## Conversation and live voice

The next local increment adds task steering and the AWS voice companion across Writer, Sheets, and Slides. See [Office conversation and voice](office-conversation-and-voice.md) for behavior, gateway setup, validation, and the remaining live AWS and durable-job boundaries.
