# Deposition audit — standalone handoff

> Published handoff: this is an audit of the source commit below, not a claim that the recommended fixes are implemented. Recorded JSON results are included. Original local probe scripts, raw logs, and browser traces are not part of this package. Reproduce the stated cases against your checkout; see [validation evidence](validation-evidence.json) and the [implementation runbook](../IMPLEMENTATION-RUNBOOK.md).

Audited commit: `f06e148fdda93553718621ab3634ce53548d7bfe` in `the repository root`.

Scope: read-only code and local synthetic module tests. No repository source edits, AWS calls, provider calls, browser actions, or deployment. Frontier research is legacy, retiring, and outside this audit.

Evidence: [recorded synthetic probe results](deposition-results.json), [results](deposition-results.json). These directly import actual pure modules with synthetic fixtures; they are not complete UI, provider, or deployment tests. The focused transcript/analysis/context/export/graph/record suite passed 64 tests. **Those tests are included in the parent's 317-test run; do not add the counts.**

## Reachable architecture

`/discovery?tab=deposition` redirects to `/docs?tab=deposition`, which renders `DepositionAnalysisTab` → `DepositionView` → `useDeposition`. Automatic covering analysis uses `/api/pile/ask` with `mode:"analyze"`, invoking `writeDepositionAnalysis`. Generic `/api/discovery/analyze` is not the deposition covering-analysis route. [Global Cognito request middleware](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/start.ts#L28) protects the API routes. Saved Ask uses the workspace KB and generic pile answer writer; the in-browser exhaustive scan is disabled.

## Prioritized findings

### P1 — Numbered continuation pages can disappear from covering analysis

The live hook calls `transcriptFromPages` in [use-deposition.ts:399](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L399). That parser selects numbered parsing only when a page contains at least two numbered Q/A markers; otherwise it selects prose parsing at [transcript.ts:335](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/transcript.ts#L335). Prose parsing ignores numbered continuation lines. The fallback at line 345 runs only if no page produced any lines.

The actual-module fixture retained page 1 but omitted page 2 containing “the valve would fail under pressure” and “We stopped sales immediately.” Long answers spanning pages and pages with a single numbered Q/A marker can reach this branch.

**Acceptance:** Every substantive source line and nonblank page has a parsed or explicitly unresolved representation. Fixtures include continuation-only pages, single-question pages, exhibits/certifications, and mixed formatting. Unresolved parsing coverage must prevent unqualified completion.

### P1 — Unnumbered testimony receives fabricated page-line citations

`parseQaProse` assigns synthetic sequential line numbers at [transcript.ts:199](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/transcript.ts#L199). The live `transcriptFromPages` path applies `citeReadyOf` to those numbers at line 348. Four prose segments become a consecutive run and therefore cite-ready.

The fixture returned `citeReady:true` for unnumbered Q/A, and quotation matching produced `1:2` with `source_matched`. Existing tests for Word without line numbers exercise `parseTranscript`, which has an extra safeguard absent from the live path.

**Acceptance:** Store physical page, printed page, printed line, and internal segment separately. Only actual source line numbers generate legal page-line citations. Internal navigation coordinates are clearly labeled. Run fixtures through `transcriptFromPages`, not only the alternate parser.

### P1 — Cross-review scales quadratically in finding batches

[use-deposition.ts:1005](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1005) enumerates every pair of finding batches, including each batch with itself, whenever more than one transcript exists. These are not transcript pairs. Each comparison invokes a model; [line 1039](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1039) runs two concurrently.

Actual batching of 3,200 small synthetic findings produced 100 batches and 5,050 cross-review calls, resending approximately 81.8 million finding characters before prompt overhead, retries, and output. This is arithmetic over real batching output, not a latency benchmark. Admission allows 20 files and 5,000 pages.

**Improvement:** Build candidate comparisons by issue, entity, time, scope, and opposing proposition; verify proposed conflicts against original testimony. Use bounded hierarchical reduction and explicit comparison coverage. Do not replace exhaustive coverage with undisclosed sampling.

**Acceptance:** A large planted-conflict corpus retains distant conflicts within declared call/input budgets. Measure candidate recall separately from semantic conflict precision. Display unreviewed comparison coverage.

### P1 — Pairwise cross-review overwrites the corpus executive summary

Global synthesis at [use-deposition.ts:1013](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1013) precedes cross-review. Each successful `runPass` merges its result into the common analysis at line 930. [mergeDepAnalysis at line 642](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/deposition-analysis.ts#L642) always prefers `next.summary`.

The last completed pairwise comparison therefore replaces the corpus summary with a summary of one finding-batch pair. Parallel completion makes the winning summary timing-dependent. The pure-module fixture confirms the overwrite.

**Acceptance:** Give summaries explicit window/transcript/batch/comparison/corpus scope. Run final corpus synthesis after comparisons. Reverse response completion order and verify identical scope and evidence coverage.

### P1 — OCR and parsed-page coverage do not survive persistence/export

OCR failures are initially reported at [use-deposition.ts:1355](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1355), but analysis proceeds over readable text. Save omits blank pages at line 664. [The durable transcript record](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/kb/deposition-record.ts#L20) has identity and line counts but no page-level extraction/OCR coverage manifest. Reload assigns `ocr:false` at [line 1412](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1412) and `empty:0` at line 1481.

Export completeness uses only pass statuses at [DepositionView.tsx:348](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/components/summarize/DepositionView.tsx#L348). A run with unresolved OCR pages can export “Analysis passes completed” without its original coverage warning. This finding concerns missing coverage metadata, not destruction of source bytes; original files may remain stored.

Related completion gap: `parseDepAnalysis("{}", true)` succeeds. Strict mode verifies JSON parsing, not required fields or window completeness. [ask-deposition.server.ts:178](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/ask-deposition.server.ts#L178) retains returned text without a completion/stop-status assessment.

**Acceptance:** Persist per-page states for extracted, OCR needed, OCR failed, confirmed blank, parsed, and analyzed; per-window completion/rejection counts; immutable source and extraction revision identifiers. Reload/export must retain missing coverage. Valid JSON alone cannot mark a window fully analyzed.

### P2 — Same-name entities merge without identity evidence

[mergeDepGraphs at line 689](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/deposition-analysis.ts#L689) uses normalized `kind:label` identity. Distinct “John Smith” records from separate transcripts collapse. The fixture shows separate employer relationships attached to one merged person.

This can create false shared references, hubs, or bridges even when both quotations genuinely occur. Quotation provenance does not establish person identity.

**Acceptance:** Keep source-scoped entity IDs and explicit identity links. Test identical full names, reused exhibit numbers, subsidiaries, and multiple depositions of one actual witness. Evidence-supported or reviewer-approved identity links must be distinguishable from name similarity.

### P2 — Durable findings exist, but durable execution recovery does not

Completed pass results live in a React map at [use-deposition.ts:287](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L287), capped at 2,500 entries at line 927. Saved records contain merged findings and four aggregate pass states, not durable window jobs/results or model/schema versions. Reopening changes interrupted running passes to error at [line 1457](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1457). The visible fresh rerun clears the cache.

“Analysis saved” is therefore different from “job resumable.” Refresh/navigation can require repeating substantial completed work.

**Acceptance:** Content-addressed per-window results and an idempotent background stage manifest keyed by source revision, parser/OCR version, prompt/schema/model, and attorney focus. Closing/reopening resumes only missing or invalidated work. Keep current stale-run write protections.

### P2 — Reopened failed-index sets advertise an unavailable default Ask fallback

Reload promises “Ask will use the loaded text” at [use-deposition.ts:1433](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1433). Default scope becomes `full` when hybrid Ask is unavailable; `FULL_TEXT_SCAN_ENABLED=false` rejects it at [line 1670](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/use-deposition.ts#L1670) before local retrieval.

**Acceptance:** Reopen a stored set with failed indexing. Either provide explicitly labeled local retrieval over loaded pages or report the actual unavailable capability and a recovery action. The default UI promise must match runtime behavior.

## Strengths to preserve

- [Complete normalized quote matching](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/deposition-analysis.ts#L489) within a named transcript, ambiguity rejection, and snapped matching spans. This is provenance, not semantic verification.
- [Exports](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/deposition-export.ts#L103) retain paired conflict evidence, distinguish source-matched from needs-review, explain semantic limits, and neutralize spreadsheet formulas.
- Context overflow fails explicitly; long testimony uses overlapping bounded splits instead of silent truncation.
- Covering calls have bounded concurrency. [mapPool](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/async.ts#L93) drains already-started workers before reporting a failure, preventing post-finalization mutations from that pool.
- [Workspace persistence](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/kb/workspace.server.ts#L1009) enforces ownership, S3 record bounds, stale-run checks, and optimistic DynamoDB revisions. Intake also uses idempotent reservations and recovery polling.
- [Mapped graph insights](https://github.com/fshahersw/workingversion/blob/f06e148fdda93553718621ab3634ce53548d7bfe/src/lib/pile/graph-insights.ts#L75) exclude unsupported relationships from structural patterns, explain inference limits, and disclose the 400-node/4,000-edge bounds.

## Implementation order

1. Lossless transcript parsing and authentic source citations.
2. Durable extraction/analysis coverage and truthful completion/export status.
3. Bounded cross-review with measured candidate recall and correctly scoped final synthesis.
4. Durable job recovery, identity resolution, and failed-index Ask recovery.

The first three stages directly improve both trustworthiness and large-workflow speed. No implementation or live performance/accuracy claims are made by this audit.
