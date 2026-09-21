# Tabular Review: correctness, performance, persistence, and export

> Published handoff: this is an audit of the source commit below, not a claim that the recommended fixes are implemented. Recorded JSON results are included. Original local probe scripts, raw logs, and browser traces are not part of this package. Reproduce the stated cases against your checkout; see [validation evidence](validation-evidence.json) and the [implementation runbook](../IMPLEMENTATION-RUNBOOK.md).

Audited `f06e148` on 2026-09-21. Read-only application audit with synthetic local probes; no application changes, AWS, or provider calls. References are relative to `workingversion/`. Working Set and the general document-scan planner are owned by the parent audit; this report focuses on their tabular-review integration.

## Active workflow and protections

- The live surface is `/docs` → Tabular Review, not the old Discovery route: `/discovery` redirects to `/docs` (`src/routes/_authenticated/discovery.tsx:9`); `DocsWorkspace` force-mounts review so ordinary tab changes do not interrupt work (`src/components/docs/DocsWorkspace.tsx:65`).
- `ReviewTablesTab` owns `useReviewTable` (`src/components/docs/review/ReviewTablesTab.tsx:110`). The hook indexes browser pages, saves originals/pages to authenticated KB workspaces, and stores table/row/column/cell state through owner-scoped server functions.
- Full text scan is the default (`src/lib/review/use-review-table.ts:198`). It processes columns sequentially and up to 3 documents concurrently, with windows sequential within a document (`:1536`, `:1705`; `full-scan.ts:88`). Relevant-passages mode runs up to 10 cells concurrently and fuses lexical and per-workspace semantic retrieval, capped at 16 pages (`types.ts:61`, `:68`; `use-review-table.ts:1211`). Weak retrieval answers widen to full scan before asserting absence (`:1637`); successful retrieval-only answers explicitly disclose non-exhaustive coverage (`:1648`).
- `/api/review/cell` authenticates and validates bounded page/question/image inputs (`src/routes/api/review/cell.ts:52`, `:89`). The active pipeline extracts with Nano→Gemma, checks citations, verifies with Gemma→Nano, then conditionally escalates to Sonnet and independently verifies its replacement (`pipeline-core.ts:55`, `:58`; `cell-pipeline.server.ts:595`, `:659`). Empty source context remains `needs_review` (`:559`).
- Full scans recheck normalized exact quote containment, preserve uncertain sections, refuse automatic scalar aggregation, merge list results across sections, and record actual covered pages (`full-scan.ts:14`, `:103`, `:147`). Failed sections remain retryable with successful sections cached in this browser tab.
- Document identity includes SHA-256 of ordered reviewed page text, including OCR repairs (`document-identity.ts:2`; `use-review-table.ts:827`, `:987`). Cell keys include row fingerprint, column/version, pipeline/scope, and a hash of table instructions and column name/question/type/options (`use-review-table.ts:1401`, `:1411`). This is materially stronger than filename-only caching.
- Automatic persistence conditionally preserves cells already verified or overridden (`review.server.ts:575`). The retained-write queue only removes batches after successful acknowledgement, keeps failed batches for retry, and serializes its own flushes (`pending-writes.ts:8`). The hook aborts new AI work on saving failure and exposes Retry saving results (`use-review-table.ts:1527`); page unload warns about unsaved writes (`:226`).

## Material findings

### P1 — Verify/unverify can erase a concurrent manual correction

`ownedCell` reads a full cell; `setCellVerified` changes one field but writes the entire stale snapshot without a condition (`review.server.ts:633`, `:697`, `:702`). A manual override between that read and put is overwritten, including its text and `overridden:true`. `overrideCell` is itself an unconditional read/modify/put and appends history after the write (`:667`, `:679`, `:687`). The existing automatic-write protection does not cover these manual-operation races.

**Reproduced with actual module functions:** pause verification after its read, apply manual override, release verification. Stored display changes from `Manual corrected answer` back to `new answer`, and `overridden` changes from true to false.

**Bounded fix:** cell revision/CAS for all edits; verify/unverify should atomically update only verification fields against the expected revision. Persist audit events with the mutation transaction or stable operation ID. Return a conflict with the current cell instead of silently discarding a user's edit.

### P1 — Stale automatic writes are accepted after newer runs or column changes

`saveCells` guards only manual flags (`review.server.ts:587`); it does not validate current document fingerprint, column version, table/row/column existence, active run generation, or expected previous cell revision. The opaque cache key is stored, not checked. `updateColumn` independently reads and replaces a column without CAS (`:413`, `:433`).

**Reproduced:** save v2/new-run answer, then save a delayed v1/old-run answer. The old answer replaces the new one. Deletion-during-run can likewise re-create cells because the save condition does not require parent records; the main visible grid filters orphan cells, which is presentation protection rather than preventing the orphan write.

**Bounded fix:** server-validated document/column snapshot plus monotonic run/cell generation and parent existence checks in a transaction. Apply the same revision discipline to column updates. Keep existing overridden/verified conditions.

### P1 — Cancel/restart and table switches lack a single run owner

`cancel()` aborts but immediately clears `abortRef` and sets `running:false` (`use-review-table.ts:1309`). That enables Fill table again while the prior run still drains persistence and `finishRun`; the old finalizer unconditionally clears `abortRef`, clears pending cells, and overwrites progress (`:1840`, `:1866`). A second run can therefore lose its controller/progress and a third can start. Both run queues reference the same `unsavedWrites.current` array (`:1496`) but each creates an independent queue lock, worsening overlap. A cell success after `attemptCell` has no final abort/generation check before enqueue (`:1732`).

`loadTable` likewise accepts whichever initial fetch resolves last (`:437`–`:447`) before its later hydration table-id guard; close/new-table actions do not invalidate that pending load. Finalizers and override/verify callbacks are not consistently guarded by table/run generation.

**Evidence:** source-confirmed interleaving; not a browser reproduction. UI re-enables Fill immediately after cancel (`ReviewTablesTab.tsx:526`).

**Bounded fix:** immutable run identity; retain ownership until all old workers/persistence settle; clear refs only if still owned; generation-check every post-await publish. Use one persistent save queue per owner/table. Loading/closing tables must invalidate earlier loads and guard all response-driven state changes.

### P1 — List extraction silently discards responsive values after item 24

`constrainValue` truncates list answers with `cleaned.slice(0, 24)` and returns no warning (`pipeline-core.ts:345`). This is upstream of full-scan section merging, so merging cannot recover removed entries. It conflicts with the prompt's instruction to retain every responsive value (`prompt.ts:23`).

**Reproduced:** 32 supplied values become 24, with `unmatched:[]`. Existing full-scan tests exercise cross-window union, not this extraction-normalization loss.

**Fix:** preserve bounded complete structured output; if a response limit is needed, return explicit incomplete/paginated output and continue extraction. Never silently truncate findings. Add a real pipeline-normalization→full-scan regression with over 24 same-section values and verify exported completeness.

### P2 — A fuzzy citation can reverse meaning while labeled verified

`quoteOnPage` accepts 85% token agreement (`pipeline-core.ts:230`), and `checkCitations` stores the model's original quote under `verified` without retaining match quality (`:282`).

**Reproduced:** source `The company will not pay damages under this settlement agreement.` accepts quote `The company will now pay damages under this settlement agreement.` The independent model verifier may catch this, but deterministic quote validation does not. Full-scan has an additional exact normalized check (`full-scan.ts:103`); retrieval mode and draft-column tests do not have that extra check.

**Fix:** fuzzy matching should locate a candidate source span, then return the actual source quote with a warning or require review. Protect negation, numbers, dates, parties, currency, and modality from approximate substitution. Persist match quality and test contradictory near-matches, not only OCR typos.

### P2 — CSV formula injection and incomplete exported audit context

CSV escaping quotes delimiters but leaves leading `=`, `+`, `-`, `@` and control-character formula prefixes intact (`export.ts:16`). Both user/source-controlled document labels and model/manual cell values reach it (`:30`). Quoting a value does not prevent spreadsheet formula interpretation.

**Reproduced:** document `=1+1` and answer `=SUM(1,2)` export unchanged as formula-capable CSV fields. The XLSX writer uses string cell values; this finding is specifically CSV.

Exports include citations/status, but omit override/verification metadata, searched-page coverage, rationale, errors, model provenance and column version (`export.ts:29`, `:94`). XLSX's Citations sheet skips entirely absent cells (`:105`), while the main sheet is blank, making not-run cells hard to distinguish from empty answers. Export remains enabled during running/unsaved work (`ReviewTablesTab.tsx:548`).

**Fix:** neutralize formula-leading CSV text while preserving display, and add a run/coverage/provenance sheet or companion columns. Snapshot export state consistently; clearly label partial/unsaved exports. Preserve native numeric types intentionally rather than emitting every reviewed number as a display string.

### P2 — Durable resume is incomplete and run creation can silently fail

`startRun` catches storage failure and returns null (`review.server.ts:760`, `:781`); the hook continues AI work because it expects an exception (`use-review-table.ts:1459`), and `finishRun(null)` is a no-op (`review.server.ts:791`). This bypasses the intended run-start failure UI.

**Reproduced:** injected storage outage returns null instead of preventing work. Run counts are only written at completion; no durable section job ledger is consumed by this hook. Successful section cache and unsaved writes exist only in memory. Reload can reuse final saved cells, but loses section progress and pending unsaved results. Ordinary Fill also skips a matching-key error cell (`use-review-table.ts:1434`); Retry failed is a separate explicit action (`ReviewTablesTab.tsx:587`).

**Fix:** fail run creation explicitly before model work; durably checkpoint cell/section work identities and outcomes. Resume from acknowledged section progress and retry only incomplete/transient work. Preserve failed-run distinctions and active-version checks instead of treating a matching error cache key as up-to-date.

### P2 — Retry multiplication, verification fallback, and escalation have inconsistent bounds

Each extraction model gets up to 3 attempts, each with 25s timeout; verifier attempts get 15s (`cell-pipeline.server.ts:76`, `:197`). The browser retries HTTP failures up to 3 total requests (`pile/discovery-scan.ts:157`), then the hook may retry the entire cell after cooldown (`use-review-table.ts:1762`). Per-process circuits reduce some repeated failures, but there is no shared cell/run retry budget or tenant concurrency governor. Every route pipeline exception becomes HTTP 500 (`routes/api/review/cell.ts:161`), including nonretryable provider failures, losing classification and Retry-After.

Sonnet escalation calls `streamWriter` without the timeout wrapper used by extraction/verification (`cell-pipeline.server.ts:362`); the same parent abort signal exists but there is no review-specific overall cell deadline. `converseOnce` reads content but ignores provider stopReason (`:166`); valid-looking but truncated structured output is not labeled incomplete. Parse failure happens after the model chain already succeeded (`:358`), so it does not attempt the next model in that chain; browser retries can select the same model again.

The verifier chain is fixed, not selected based on `extractModel` (`:488`). If extraction falls back to Gemma, verification can also use Gemma; a Nano fallback verifier can similarly repeat the extractor family. Thus independent calls exist, but a different-family verification guarantee does not always hold. Model provenance returned by the pipeline is not persisted by the hook's CellWrite mapping (`use-review-table.ts:1671`).

**Fix:** one cell deadline and attempt budget across extraction/verification/escalation/HTTP retry; typed retryable errors with bounded jitter and budget-aware provider fallback. Treat output limits as incomplete, repair malformed JSON once before provider fallback, select a different verifier family when available, and record degraded independence explicitly. Preserve model/protocol/verification evidence in durable results.

### P2 — OCR and preview behavior differ after reopening

Hydration assigns every stored page `ocr:false` and every file `ocrPages:0` (`use-review-table.ts:370`, `:387`). Vision reread requires both an original PDF retained in `fileBlobs` and pages flagged as OCR (`:1332`); originals are cleared on close (`:540`). A reopened review therefore cannot perform the same image reread even when source bytes exist in saved storage. Semantic-only pages also default to non-OCR when they were absent from the lexical pack (`:1290`).

OCR recovery replaces text only if the new text is longer (`ocr-pages.ts:33`), which can reject a correct shorter result for a long garbage text layer. Draft `Test on 10` uses the first rows and retrieval-only requestCell without full-scan widening, vision reread, or cancellation (`use-review-table.ts:1905`–`:1923`), so it does not represent the default production run semantics.

**Fix:** persist/rehydrate OCR provenance and page quality; retrieve owned original page images lazily for flagged saved documents. Choose replacement by quality/confidence, not length alone. Align preview with the selected run scope and deliberately sample document formats/lengths/OCR quality; label sampled evidence coverage.

## Bounded optimization sequence, preserving accuracy

Current workload scales with `columns × sum(document scan windows)`, not just the visible cell count. Each section needs extraction, and supported positives then need verification; escalation/retries increase this. The configured 120-document and 40-column limits permit 4,800 visible cells, with up to 20,000 shared pages (`pile/limits.ts:2`, `:6`; `review/types.ts:55`), making repeated full-document work substantial. Full scan uses 3 active rows and 1 active section per row; relevant-passages mode uses 10 active cells, while semantic retrieval uses 4 workspace calls. Columns form a sequential barrier. `fullPageCache` avoids rereading a document's text for each column within a run, but section-result cache keys intentionally include the column request, so different questions still require new extraction. Source preparation can be shared safely; answer/coverage work cannot be treated as interchangeable.

1. **Correctness first:** ownership/cell revisions, safe manual mutations, list completeness, exact-source quotations, and safe export. Add race-controlled actual-function tests and a small browser cancel/restart/table-switch acceptance.
2. **Operational control:** one run-level scheduler and durable section checkpoints keyed by owner, immutable document evidence hash, column snapshot, pipeline revision, and section boundaries. Keep conditional save safety; parallelize bounded independent Dynamo writes rather than switching to an unconditional batch-write shortcut. Reuse page reads/digests, and avoid repeating hydration/embedding retrieval per column when stable inputs can be shared.
3. **Bounded adaptive throughput:** tune row/section concurrency against measured provider throttling and latency, with per-tenant/global caps. The current full-scan pattern is columns sequential × 3 rows × sequential windows. Schedule independent sections across a small global queue while retaining deterministic per-cell aggregation and exact coverage. Never replace exhaustive review with retrieval solely to improve latency.
4. **JEV only through AgentCore:** there is no JEV invocation in the current review flow. Any new classification must use authenticated AgentCore Gateway → dedicated Lambda adapter → TypeSafe API, not the existing direct TypeSafe transport. Use constrained output for document/column intent, independent-work grouping, priority, likely OCR need, and routing among approved pipeline paths. Validate enums/confidence, bound timeout, keep deterministic fallback. JEV must not certify legal facts, invent citations, suppress unresolved sections, or establish document-wide absence; uncertain/negative relevance labels cannot silently drop required coverage.
5. **Measure complete work:** time to first saved cell, pages/sections actually covered, per-stage model latency/attempts, verified-vs-degraded answers, OCR gaps, save queue age, cancelled work still active, and cold-resume work repeated. Benchmark representative long lists, contradictory clauses, financial numerics, scanned pages, and multi-table concurrent edits before increasing caps.

## Existing tests and evidence limits

- `document-identity.test.ts:6`, `:23`, `:33`: changed content versus legacy identity and canonical page hashing.
- `pending-writes.test.ts:5`, `:22`: rejection retention and concurrent flushes on **one** queue instance; not two run-created queues sharing one pending array.
- `review-integrity.test.ts`: several AST/text-pattern checks for helper use/cascades/stat filters. These do not simulate concurrent Dynamo operations or React ownership races.
- `pipeline-core.test.ts:42`, `:60`, `:121`, `:142`: quote matching, basic citation rejection, chain ordering and circuits; the fuzzy acceptance test does not protect negation/numeric meaning.
- `full-scan.test.ts:13`, `:23`, `:40`, `:50`, `:90`: cross-window list union, scalar conflict, uncertainty, failed-window retry, unsupported quotes. These are valuable but do not cover upstream list truncation, durable reload, or real pipeline transport.
- `review-sources.test.ts:27`, `:37`: bindings and hydration plans; not actual restored OCR/image parity.
- `review-probes.ts` executes the actual persistence module after TypeScript AST removal of imports, injecting only in-memory storage and ID helpers. Results in `review-probe-results.json` prove the storage races, null run-start failure, fuzzy contradictory quote acceptance, CSV field issue, and silent list truncation. No SDK/provider calls were made. React cancellation/load races remain source-confirmed, not browser-reproduced in this audit.

No production performance measurements or deployed configuration are inferred from these local tests.
