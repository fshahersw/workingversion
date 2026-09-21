# Complex Office workflow hardening

This increment addresses the reported failure while creating a mock five-year Tesla-style quarterly income statement. Testing uses synthetic files in the local stack. AWS access remains deferred, production inference remains Bedrock, and no deployment or remote push was performed.

## Failure evidence

- The original reported browser task performed research/guide reads without completing the workbook. Its exact upstream failure was not retained; no precise provider cause is asserted for that original run.
- A fresh browser reproduction included a queued instruction for 20 quarters (2021–2025), a formula-based annual summary, assumptions, synthetic-data labeling, and checks. It created three worksheets, then encountered an upstream stream error followed by HTTP 400. A subsequent independent one-message health check identified the 400 as **insufficient Anthropic API credits**. That diagnostic does not establish the cause of the preceding stream error.
- The authorized Fireworks fallback initially consumed all 8,192 output tokens in 66.9 seconds without returning an action or answer. This was reported as partial, not completed. Its GLM-5.3-Flash model defaults to maximum reasoning when effort is omitted. A controlled read-tool probe using explicit `reasoning_effort: low` returned the correct tool in 1,777 ms. These are individual observations, not a performance benchmark.

## Changes and intended behavior

| Area | Change |
| --- | --- |
| Long tasks | Compact complete historical tool exchanges during the active run, retaining the original goal, authoritative user updates, recent work and source receipts. Defaults are 256 KiB total history and 96 KiB recent history; this is a conservative byte heuristic, not a token-window guarantee. |
| Recovery | Keep original requests and paired completed-tool receipts after a failure. Before continuing, the model must inspect the current artifact because rollback may have changed it. Retry at most twice for transient stream failures; discard unfinished proposals and never replay executed writes automatically. |
| Large outputs | A provider-confirmed truncated tool batch is entirely unexecutable, including any complete-looking prefix. Feed it back for smaller batches, with bounded repair attempts counted per round. |
| Routing | Continuation requests, queued directions and active compaction context stay on the main model. JEV does not treat a short follow-up as a new isolated cheap edit. |
| Workbook execution | Explicit typed common-operation schemas; staged creation, fresh sheet IDs, bounded content writes, formulas, computed readback, charts, formatting and final checks. Mock data is permitted when requested and labeled; actual financial results require sources. |
| Verification | Failed/incomplete formula scans cannot mean clean. A failed post-edit readback cannot claim the edit was unapplied. Chart creation and finish-table passes follow completed data writes because planning reads current state. |
| Chart accuracy | Formula-result changes trigger bounded dependent-chart refresh. Native save refreshes supported chart caches after calculation without mutating the live edit journal. Sparse numeric caches retain missing-point indexes and native point counts rather than inventing zeros. Explicit primary/secondary axis number formats travel through the edit schema, live chart and native XML. Unsupported imported reference forms are preserved. |
| Research | Configured local public search returns verified provider search results or explicit failure. Public page excerpts carry source revisions and line-boundary continuation; a changed page cannot silently join an older excerpt. Production research continues through its existing path. |
| Local capabilities | Remove unavailable AWS-only tools. Hide visual inspection tools for an unverified text-only Fireworks configuration. Keep native data/formula/style operations and report missing capabilities explicitly. |
| Panel | Intentionally skipped tools display Skipped rather than Failed and survive reload. Recovery receipts remain complete in model/storage context but collapse under Recovery details in all four panels. |
| PDF | Longer bounded runs, typed transport failures, partial-result wording and checkpoint preservation even if rollback itself fails. |
| Lifecycle | Closing a finished Sheets/Slides page releases its worker session; back-forward-cache navigation does not prematurely release it. |

Sheets and Slides allow up to 120 model rounds per task; PDF allows 100, and Writer allows 100 in Standard or 200 in Thorough. These are bounded interaction budgets, not promises of successful completion or uninterrupted background execution. Independent read tools may run together; document mutations remain ordered so a later edit cannot race its prerequisites.

The shared loop regression completes 70 rounds over two user requests with repeated compaction and intact tool pairs. Separate tests cover queued steering, partial stream fragments, late callbacks, stale session/conversation guards, malformed batches, cancellation, recovery persistence, and neutral skipped activity. Deterministic regressions do not substitute for live model acceptance.

## Complex browser acceptance and independent findings

The real Fireworks-backed Sheets agent completed a 35-model-round run with 37 tool calls in approximately 233 seconds, including a queued user instruction, failed proposals, readbacks and repairs. Model time totaled 226 seconds. The UI reported 519 changes. Summed provider usage was 1,276,624 prompt tokens across repeated contexts and 26,775 output tokens; prompt counts are not unique document tokens or a billing estimate. Cache telemetry was missing from the adapter at that time, so its zeros cannot establish cache misses. The adapter now reads Fireworks' documented nested cached-token field.

The generated native workbook contained 20 quarters, five annual periods, three worksheets, 345 formula caches and three editable charts. Independent checks confirmed annual sums and the gross-profit, operating-income and margin identities. This first result was **not accepted as correct**: inspection found defects the model's final summary missed.

- Numeric year headers became an extra revenue series; annual chart categories were ordinal numbers. Conservative year-header recognition and explicit category-range guidance now address these cases. A chart's source range alone is insufficient verification.
- Creating the first stylesheet and new sheets in the same save allocated a duplicate workbook relationship ID. Stylesheet allocation now precedes sheet allocation, with a regression exercising the actual retained native engine.
- Browser chart-cache changes had not reached the separately vendored engine schema. Later saves rejected the sparse-cache field. Shared schema/writer modules are synchronized, with actual engine-boundary tests and a drift check.
- Four malformed proposals supplied `operations` as a quoted string containing invalid JSON, rather than an array. Rejection now provides bounded type/field diagnostics and an exact wrapper example, without attempting an unsafe automatic repair.
- The right-alignment adapter passed an unsupported facade value. Right alignment now uses the facade's supported value; clearing alignment resets the raw style instead of forcing right alignment.
- A later correction run exposed a stale chart inventory: pending deletions and series edits were not reflected in the agent's read tool. It falsely reported three charts when native export contained two. Current chart inventory now applies the pending journal, omits removed objects/sheets, and exposes bounded series counts and category/value references before a completion claim. Counts remain complete when details are truncated.
- Manual save could rehydrate the same persisted conversation alongside the live conversation. Hydration now uses stable chat identity and rejects stale asynchronous results, including a conversation reset during history loading. A narrow commit lock prevents edits from being discarded while native save replaces its session; save preparation remains guarded by journal snapshots. A research approval returning after a save or conversation change cannot start a task in the newer scope or clear the composer's input.

The original generated revision is retained as failure evidence. A separate synthetic copy received a single explicit package repair to its duplicate stylesheet relationship for the follow-up agent test. This forensic fixture repair is not an automatic production repair feature.

After the inventory fix, the real agent restored the missing annual chart and checked its effective series. That continuation used 16 model rounds and 18 tool calls in approximately 27.3 seconds, including two recovered invalid tool requests. Fireworks reported 278,528 cached prompt tokens out of 315,745 total prompt tokens for that continuation (88.2%). These are observed counts from one run, not a general latency, quality or cost guarantee.

Independent inspection of the saved three-chart revision passed 515 financial/native checks, including nine identity families across 25 periods and 18 chart-cache/source vectors. A separate openpyxl/XML comparison passed 4,434 checks against the preserved input: all original values and formulas remained unchanged, all 345 formula caches were present, and all 17 numeric CAGR results had percentage formatting and right alignment. The annual revenue chart had three revenue series with five year labels; the combo had two series with the correct year references and a separate right margin axis; the quarterly chart retained four series across 20 quarters. This is stronger evidence than a successful final chat message, but does not certify Microsoft Excel rendering.

## Final accepted artifact and checks

The final targeted browser task changed only the combo chart title and explicit axis formats: primary `#,##0`, secondary `0.0%`. The accepted native document is revision **7**, SHA-256 `4c1cc32b06d0ee1612f973ad7814f208335e12f30ee8c0ca74cdd3f17d94caa9`, 27,967 bytes. It retains three sheets, three editable charts and 345 formulas with computed caches. Browser inspection after reopening confirmed 2021–2025 labels and percentage precision matching the requested format.

The first axis-format attempt was invalidated by development hot reloads during test-file changes, which discarded its unsaved editor state. The repeat held all repository files fixed through save and native inspection. It is the repeat, not that interrupted attempt, that supplies final acceptance evidence.

| Check | Final result |
| --- | --- |
| Shared/library/UI regression suite | 979 passed, one opt-in Dynamo integration test skipped, zero failures, 158 files. The earlier real Dynamo concurrency test is recorded separately in the initial implementation report. |
| TypeScript | Passed. |
| Retained Office engine build and tests | Passed; 11 tests, including actual save/package preservation and chart wire/native schema checks. |
| Production Vite build | Passed on Windows/x64; existing large-chunk warnings remain. |
| Emitted PDF parser isolation | Passed, two-page fixture, using emitted dependencies only. |
| Lambda native-target/packaging guards | Four passed. This is a packaging-boundary check, not an AWS deployment. |
| Final financial/native workbook inspection | 515 checks passed; nine financial identity families across 25 periods, 18 chart cache/source vectors; no failures or unchecked required findings. |
| Independent openpyxl/XML comparison | 4,444 checks against the repaired original, and 4,479 against the pre-axis revision; no failures or warnings. Explicit axis formats, unlinked number formats and original axis titles verified. |
| Narrow edit preservation | Only `xl/charts/chart2.xml` changed compared with the pre-axis revision. All other package entries are byte-identical. That chart differs only in the requested title and axis number formats. |

The deliverable workbook and sanitized independent reports are in the task's sibling `analysis/deliverables` directory. The platform assessment and initial implementation record remain applicable to the wider Writer, Slides, PDF and JEV work; this increment adds the complex-task evidence above.

## Compatibility and release boundaries

Native XLSX inspection must check formulas and cached results, chart references/caches, units, periods, styles and synthetic labeling. A browser table or a CSV is not evidence that the full native workbook is correct. Actual Microsoft Excel application acceptance and a broader workbook corpus remain separate gates.

The local Fireworks model used here has no verified vision capability. It can read native cells, formulas and formatting metadata; it cannot claim screenshot-based layout inspection. Human/independent browser inspection is recorded separately. The local model effort switch does not alter production Bedrock settings.

Office runs remain browser-owned. This increment does not add a durable background workflow scheduler, cross-tab editing leases or a universal guarantee for arbitrary-length work. AWS staging must still validate actual model access, runtime packaging, persistence, cancellation and native downloads before release.

## Primary references

- [GLM-5.3-Flash model card](https://huggingface.co/zai-org/GLM-5.3-Flash#note): model-specific effort defaults.
- [Z.ai thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode): models whose thinking cannot be disabled.
- [Fireworks chat-completions API](https://docs.fireworks.ai/api-reference/post-chatcompletions) and [prompt caching](https://docs.fireworks.ai/guides/prompt-caching): request controls and prefix reuse.

See `office-improvements-validation.md` for the earlier native Office/PDF implementation, pinned upstream research and safe AWS release sequence. See `office-local-development.md` for local configuration without persisted credentials.
