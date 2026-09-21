# Workflows tools, models, evidence, and outputs — read-only audit

Audited HEAD: `0afb944b739406e1e3327e589431ac16f4ad4eb1`.

This tools sub-audit made no application edits, AWS/provider calls, browser actions, or commits. The separate abandoned backend-harness exception is documented in [validation evidence](validation-evidence.json). Frontier is excluded. Executable probes (recorded locally; see [validation evidence](validation-evidence.json)) and [results](tools-results.json) describe the original local run; the synthetic result JSON is included here. They use actual pure modules and isolated actual-function ASTs with synthetic sources; the adapter budget probe substitutes a fake Bedrock transport. Native DOCX/PDF probes execute the actual export functions with installed document libraries. These are not live end-to-end workflow acceptance tests. The overview records the comprehensive test count; do not add independent probe counts to it.

## Active architecture and capability boundaries

[worker.server.ts:68](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/worker.server.ts#L68) creates `productionAdapter`, executes one workflow step, persists usage/results, and enqueues continuation. It polls cancellation every five seconds and uses a 780-second watchdog. Completed steps persist; there is no per-chunk checkpoint.

- `extract`, `table`, `compare`, and Bedrock recipes use [createGroundedAdapter](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/grounded-adapter.ts#L113): page-aware 48,000-character chunks, six concurrent calls, validated exact source ranges and quotes, then a report.
- `prompt`, `agent`, and `edit` first extract file evidence when present, then make text-only drafting/refinement calls. They do not perform a model-driven tool loop.
- Search/MCP/citation steps invoke one approved research tool; scrape uses the guarded page fetcher; workspace search checks ownership; Python uses a fresh AgentCore interpreter session.
- Document steps assemble text artifacts. Real DOCX/PDF bytes are generated later in browser download/export helpers, not by the worker. DOCX source ingestion is raw-text extraction, not native editing/format preservation.
- No JEV/TypeSafe decision path exists in the audited workflow adapter. Model tiers select server-configured Bedrock models. If adding JEV, production must use **Gateway → Lambda adapter → TypeSafe**, as required; do not substitute direct browser/provider calls.

## Findings and acceptance criteria

### P1 — Four approved docket tools cannot receive their required identifiers

[tool-contracts.ts:66](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/tool-contracts.ts#L66) assigns the generic `{query,term,limit}` schema to `db_get_case`, `db_docket_sheet`, `db_calendar`, and `db_read_filing`. Actual implementations require `case_id` at [tools.server.ts:1058](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/agents/tools.server.ts#L1058), [1241](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/agents/tools.server.ts#L1241), and [1293](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/agents/tools.server.ts#L1293), or `document_id` at [1019](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/agents/tools.server.ts#L1019).

Actual contract probes supplied both identifiers with the required generic fields: validation succeeded but stripped both identifiers. Supplying only the correct identifier instead fails the generic schema. Structured MCP therefore cannot repair the mismatch. Scoped search fields such as court/case filters are also unavailable through generic schemas.

**Acceptance:** Derive/adapt exact schemas from executable tool contracts; invoke each approved tool against a mocked real implementation with valid and invalid arguments. Require identifiers for read operations, preserve supported scope/date/sort fields, and reject unknown fields explicitly rather than silently discarding important scope.

### P1 — Multi-branch file evidence is dropped and selected context is ignored

[evidence.ts:56](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/evidence.ts#L56) selects only the most recent ancestor with `files`. [adapter.server.ts:202](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L202) excludes every file-producing ancestor from drafting's other upstream material. Thus two search/scrape branches feeding a draft retain only the latest branch's result file; earlier branches are absent, not merely duplicated elsewhere.

The UI's context checkboxes at [StepInspector.tsx:403](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/StepInspector.tsx#L403) do not affect execution. `config.context` is stored and validated by plan schema, but [engine.ts:260](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/engine.ts#L260) supplies all completed ancestors, and the adapter never reads the selected list.

**Acceptance:** Make source selection explicit and deterministic from graph inputs/context. Test two independent research branches, selected/unselected sources, shared ancestor deduplication, and branch order reversal. Preserve source identities and distinguish original evidence from snippets and generated intermediate text.

### P1 — Report construction discards findings after row 1,200

[makeReport at evidence.ts:102](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/evidence.ts#L102) slices the actual report to 1,200 rows. A warning and total count survive, but discarded rows are absent from text, CSV, downstream extraction fields, comparisons, and persisted output. The actual 1,201-row fixture loses a critical final finding entirely.

This is disclosed truncation, not silent truncation, but it is more consequential than the warning's “Showing” wording: the remainder is not available for pagination/download, and downstream synthesis receives incomplete evidence.

**Acceptance:** Keep the complete canonical result, with separate display pagination and bounded synthesis batches. A final-row critical finding must survive persistence, downstream comparison, native output, and complete CSV export. If a true storage limit is reached, stop before presenting a complete report or persist explicitly identified continuation parts.

### P1/P2 — Downloaded artifacts lose displayed content/provenance or render it off-page

- **P1:** Comparison synthesis is inserted into `report.text` at [adapter.server.ts:197](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L197). [reportDocumentBlob](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/files.ts#L160) exports summary/table/notes and only a special `EDITED DRAFT` text segment, omitting the comparison narrative. The native DOCX XML probe contains the evidence table but not a unique comparison conclusion present in the UI report.
- **P1:** [reportCsv at evidence.ts:77](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/evidence.ts#L77) omits secondary `references` and `endLine`. The paired-evidence fixture retains its second-side quotation in report text but loses it in CSV.
- **P2:** [files.ts:132](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/files.ts#L132) wraps PDF text only at spaces. A single long URL/token remains unbroken. The actual PDF export succeeds with a 1,510.4-point text run starting at x=55 on a 612-point page. Its text is native but visually extends outside the page.

**Acceptance:** Use a common structured content/evidence representation for UI and export. Round-trip native DOCX/PDF and compare all narrative sections, paired sources, locators, and qualifications. CSV needs a normalized references table or lossless reference field. Test long URLs/unbroken identifiers and verify every rendered text box lies within page bounds. Existing Unicode PDF rejection is honest and should remain until an appropriate font is embedded.

### P1/P2 — Failed chunk work continues and request budgets can be exceeded

[grounded-adapter.ts:95](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/grounded-adapter.ts#L95) uses `Promise.all` without a failure flag, draining, or sibling cancellation. When one chunk fails, the step rejects while other workers continue scheduling later chunks. Actual probe: rejection occurred after six calls started; all twelve chunks were eventually invoked, with eleven successful completions after the first failure. The worker may finalize usage/output before those late calls settle.

[adapter.server.ts:76](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L76) checks completed request count before the network call and increments only after awaiting it at line 92. Actual-adapter AST probe with 199 prior requests admitted six simultaneous new completions, reaching **205 despite the stated 200-run cap**. Failed transport attempts also do not increment this counter.

**Acceptance:** Reserve request slots before dispatch, track attempted/completed/failed calls, stop scheduling immediately on fatal failure, abort/drain active calls, and save final settled accounting. Add actual-adapter concurrency tests at 99/100 and 199/200 boundaries and assert zero calls start after failure. Persist successful chunk checkpoints if a later call fails.

Research tools have a separate cancellation gap: [adapter.server.ts:409](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L409) passes no `ctx.signal` to the research executor, unlike Bedrock, scrape, KB, and Python calls. Cancellation can stop result acceptance while underlying research requests continue. Acceptance should verify provider transport cancellation, not only a cancelled run badge.

### P1 — Default Python step contract does not match the actual runtime

The [catalog Python example](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/catalog.ts#L232) says input is in `context` and assigns JSON-compatible output to `result`. [python.server.ts:69](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/python.server.ts#L69) only writes `workflow_inputs.json` containing `{inputs,values}`, then executes raw code with `clearContext:true`. It neither defines `context` nor serializes `result`. The example therefore references an undefined variable; an assignment-only custom script can return no useful serialized result.

The adapter returns text content only and does not retrieve generated native files before stopping the isolated session. File-generation use cases therefore need an explicit artifact contract rather than assuming an interpreter-created file is delivered.

**Acceptance:** Test the exact UI default end to end against a fake interpreter protocol or local equivalent. Define a documented bootstrap input shape and result protocol, JSON serialization/error rules, bounded file retrieval, and cleanup. Preserve fresh per-invocation sessions, cancellation signals, and mandatory cleanup. This audit does not infer the configured interpreter's network isolation policy without infrastructure evidence.

### P2 — Agent tools and skill completeness are overstated

[StepInspector.tsx:475](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/StepInspector.tsx#L475) offers an “Allowed tool group,” but agent belongs to `draftKinds`, and [adapter.server.ts:32](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L32) explicitly instructs that no external tools are available. `config.tool` is not read in that path. It is a drafting/refinement step, not an autonomous tool-calling agent.

The skill endpoint loads plain prompt text at [api.server.ts:147](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/api.server.ts#L147). Skill envelopes and acceptance procedures are instructions, not runtime schemas/gates. Actual module inventory: 146 bodies, of which 14 end in an ellipsis; the adverse-event analyst ends mid-acceptance-check at [skills-instructions.server.ts:79](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/skills-instructions.server.ts#L79). The corpus is not uniformly full text despite the file header.

**Acceptance:** Either label the step accurately or implement a bounded server tool loop with exact tool schemas and traceable calls. Validate skill corpus against authoritative source/hash and reject truncated generated entries. Separate prompt suggestions from enforced evidence/output contracts. The overview separately records the UI skill-application state-update defect; do not confuse that with this corpus finding.

## Model/context controls: exact behavior

- Model tier, maximum tokens, and iteration controls **are live** for prompt/agent/edit at [adapter.server.ts:220](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L220). Default draft cap is 32,768; bounds are 512–32,768 and one to four passes. `fast` resolves to the fast model; balanced to research; deep uses `BEDROCK_WORKFLOW_DEEP_MODEL` or research fallback. A README claiming universal 8,192 is stale.
- The preliminary file extraction always uses the research model with 16,384 output tokens at [adapter.server.ts:104](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts#L104), independent of the draft tier. Fast draft does not mean fast extraction.
- Iterations re-prompt the same model against the same evidence; this is refinement, not independent verification. Context selection is ignored as described above.
- Host request bounds are character-based, not tokenizer/model-window based. Oversized prompts fail rather than silently truncate. Sources are capped at 20 files, 20 MB each, 300 PDF pages, 500,000 extracted characters/file, and 1,000,000/run.

## Strengths and performance priorities

- Exact source ID/range/quote validation is an actual gate; provenance is explicitly distinguished from semantic/legal correctness. Duplicate source IDs fail.
- Chunk order is stable; output token truncation/non-`end_turn` responses are rejected; oversized context fails explicitly. PDF parser releases its worker, flags low-text pages, and rejects unreadable whole documents rather than pretending OCR ran.
- File hashes and extraction warnings exist. Email attachments are explicitly reported as unopened; DOCX extraction warnings propagate.
- Tool allowlisting, ownership checks for KB, guarded scrape, same-origin/authenticated API, prototype-safe variable resolution, explicit unknown-branch rejection, and conservative citation-existence wording are useful protections.
- Native DOCX/PDF generation is real; notification steps explicitly draft rather than send; isolated Python sessions are stopped in `finally`.
- Prioritize exact contracts and lossless evidence/export first; then durable per-chunk reuse, failure-aware bounded pools, model-aware context estimation, and explicit multi-input source flow. Repeated drafting steps currently re-extract the same files; cache by source hash, parser/prompt/schema/model version, fields, and task so reuse remains correct.
- Massive matters remain bounded batch workflows, not a durable whole-corpus agent: inputs are limited, chunks have no durable sub-step checkpoints, and each step must finish within the worker window. Report those practical limits and measure completion/recovery with real large synthetic corpora before increasing concurrency.
