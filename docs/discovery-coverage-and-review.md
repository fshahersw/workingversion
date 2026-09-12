# Discovery coverage and review improvements

Scope: the real Seeger Weiss AI platform, local checkout on `codex/discovery-reliability-graph`. This work does not integrate the MCO application, change production data, or deploy to testing/production.

## Working set and deposition questions

- **Full text scan** is the default for new questions. Every available text page in the selected files is assigned to a bounded window. Long pages overlap at boundaries; their endings are not discarded. Full coverage refers to text processed, not guaranteed recall.
- **Relevant passages** remains available for faster exploratory questions. The interface identifies it as nonexhaustive. Working-set document type, format, and explicit file filters determine the query scope. Deposition questions can target all transcripts or the selected transcript.
- A scan runs three windows concurrently. Recoverable HTTP/network failures get up to three client attempts with backoff and Retry-After support; existing provider chains also have bounded retries. Invalid requests and expired authentication are not retried as transport failures.
- Successful windows are cached in memory using SHA-256 of the question, instructions and source content. Repeating a question reuses these windows, while failed windows are eligible to run again. Caches are bounded and reset when the workspace closes; they are not durable background jobs.
- Coverage records source pages, successfully scanned pages, missing/empty text, failed sections and reused sections. Blank pages are conservatively reported as unavailable text; they may be genuinely blank or require OCR. A partial scan cannot establish absence.
- Source quotes must match the actual named page after conservative Unicode/whitespace normalization. Unsupported references are rejected and that section is marked incomplete. A matched quote establishes provenance, not the correctness of the model's interpretation.
- Large findings sets use bounded synthesis stages, with every retained source-linked finding still included in the per-document evidence report. If synthesis fails, the findings remain available. No output is described as a legal conclusion merely because it has a citation.

## Tabular review

- Full text scans run at three rows concurrently, one section at a time within each cell. The document text is loaded once per row per run and reused across columns.
- Every section uses the existing extraction, citation validation, independent verification, and escalation pipeline. A replacement answer receives its own verification; unavailable or adverse verification leaves it flagged for review.
- Full scans retain the existing image reread path for difficult OCR excerpts when the original PDF is available. Image-derived readings remain marked for review. Missing original bytes and unreadable pages are not magically repaired by a text scan.
- List and multi-select columns combine distinct section values. Conflicting scalar answers are shown as alternatives for review, rather than selecting one or adding numbers without justification. Long-text questions with differing section answers can consequently require human consolidation.
- Weak answers from relevant-passage mode automatically widen to the full document. The cell's rationale records coverage, and `pagesSearched` records successfully processed pages. Existing data contracts are retained; no database migration is required.
- Cache identity includes source fingerprint, column version, full question/type/options, matter instructions, pipeline version, and scan mode. Verified and manually overridden cells remain protected by the existing server-side write checks.
- Failed cells have a dedicated retry action. Computed results awaiting a database write continue to use the separate save-recovery queue; a save failure does not require another AI call.
- **Suggest columns** samples the beginning, middle and end of every loaded document within an explicit character budget. It proposes typed questions from those actual excerpts and the reviewer's objective. Suggestions are clearly labeled as sampled, editable, selectable, validated and deduplicated. They are not prefilled answers. Missing document text prevents silently generating from only a subset.

## Deposition analysis and exports

- Bulk intake accepts up to 20 transcripts within the existing combined 5,000-page and 200 MiB limits. It retains strict extraction and explicit upload rejection rather than accepting a truncated record.
- Transcript coverage shows identified witness, source page count, Q&A blocks, missing page/line references and repeated witness labels. Matching labels do not cause source files to be merged.
- Analysis passes detect interrupted streams, retry recoverable failures and retain successful pass results in memory for retry. An explicit Re-run starts fresh; retrying an incomplete analysis reuses completed work.
- Exports can select summary, background, admissions, impeachment leads, themes, objections, timeline, exhibits, witnesses, potential conflicts and graph relationships. Word, Markdown and CSV retain source references and review status. Paired conflicts retain both sides. Spreadsheet formula prefixes are neutralized.

## Product research and limits

Primary vendor material reviewed on September 12, 2026; product descriptions are vendor claims, not independent accuracy benchmarks:

- [Everlaw Review Assistant](https://www.everlaw.com/product/everlaw-ai/review-assistant/) describes batch processing, structured extractions, document questions and citations. This informed visible per-document coverage and recoverable batch work.
- [Everlaw AI technology](https://support.everlaw.com/hc/en-us/articles/25606806162331-The-Technology-Behind-Everlaw-AI) describes case context, source grounding and human review. Full-text processing should never be presented as guaranteed recall.
- [Harvey's review algorithm](https://www.harvey.ai/blog/rebuilding-harveys-review-algorithm) emphasizes citation quality and review-table reliability. This informed fresh verification of escalated answers, strict evidence windows and retained review flags.
- [Legora Tabular Review](https://legora.com/product/tabular-review) describes document rows, question columns, source inspection and review controls. This informed document-guided typed columns while retaining protected reviewed cells.

This is not an Everlaw replacement. The highest-value remaining professional e-discovery capabilities are:

1. Custodians, email threads and attachment families; exact and near-duplicate grouping with explicit inclusive/exclusive scope semantics.
2. Responsive/issue/privilege coding, review assignments, second-review sampling, adjudication queues and immutable audit events.
3. Redaction and privilege-log workflows, validated Bates numbering, production sets and load-file quality checks.
4. Durable server-side jobs that resume across sessions, calibrated recall/precision evaluation with attorney-labeled test sets, and monitoring for changing OCR/model behavior.
5. Original-page visual verification for every citation, document version lineage and source access controls that survive exports and cross-workspace reuse.

Do not represent any of those as implemented by the scope selector or scan engine. Before deployment, validate with authorized representative transcripts and review sets in the intended AWS/Cognito environment. Local browser tests intercept model/storage endpoints; they do not prove hosted model quality, IAM correctness, OCR fidelity or production saving.

## Key code locations

- `src/lib/pile/discovery-scan.ts`: bounded planning, quote validation, retries, progress and evidence synthesis.
- `src/routes/api/discovery/analyze.ts`: authenticated server-side model calls for scanning, synthesis and column design.
- `src/lib/review/full-scan.ts`: complete-cell scanning, conservative section reconciliation and resumable results.
- `src/lib/review/column-suggestions.ts`: distributed sampling and validated column proposals.
- `src/lib/pile/deposition-export.ts`: selective evidence-preserving exports.
- `tests/discovery`: browser-only fixtures and workflow checks. Fixtures are not runtime records or authentication bypasses.

Retain `docs/discovery-reliability-graph.md` and `docs/deposition-mapped-insights.md` for the preceding persistence and graph changes in this same local branch.

## Local validation

- 435 unit tests passed, including lossless scan planning, failed-section recovery, cancellation, source validation, conservative cell reconciliation, distributed column sampling and selective exports.
- 11 browser checks passed, including native deposition analysis/save recovery, full-text Ask on real test uploads in the working-set and deposition views, scan reuse, editable column suggestions, selective CSV downloads, and graph navigation/framing.
- TypeScript and the production build passed. ESLint reported zero errors and four existing hook/component-export warnings. `git diff --check` passed.
- The unauthenticated analysis endpoint returned HTTP 401; no test authentication bypass was added to the app.
- Dev remains at `http://localhost:5176/docs`. Browser model/storage responses were intercepted in tests; no live AWS document write or model-quality benchmark was performed.
