# Workflows engine audit

Source: `0afb944b739406e1e3327e589431ac16f4ad4eb1`, 2026-09-21. Read-only audit of engine/graph/policy/plan schema/recipes/register helpers and relevant tests. No application edits, AWS/provider calls, commits, or full-suite rerun. Source paths below are relative to the repository root. Recorded actual-module offline results are in [engine-results.json](engine-results.json). The original local probe script is not published; implement portable regressions from the fixtures below.

## Current executable contract

- **Live admission:** `policy.parseDefinition` calls `graph.importWorkflow`; `policy.assertRunnable` calls `validateWorkflow` and adds source/reviewer/selection/app-field checks. The graph requires one trigger, unique outputs, forward reachability, no cycles, two labeled condition branches, and valid upstream context names (`graph.ts:54`, `:88`, `:118`, `:153`). Limits are 80 nodes/160 edges; input policy limits files/pages/characters separately.
- **Prepared, not wired into a live generation path:** `plan-schema.ts` is a stricter intermediate plan representation with 2–14 steps, typed per-kind settings, approved tools, structural checks and materialization. Import search finds tests as its callers; it is not the actual server/Builder admission gate today. Its declared request budget is plan metadata rather than the actual runtime accounting contract. Do not describe these schema tests as enforcing every current saved workflow.
- **Frozen run:** `createRun` validates the selected draft/published graph, deep-clones it and inputs, and initializes pending results (`engine.ts:223`). A saved run therefore carries its own graph snapshot.
- **Dependency readiness:** a node waits for all incoming source nodes to be completed or skipped (`engine.ts:329`). It then activates if **any** incoming edge is active (`:332`). Unselected paths propagate `skipped`; branch joins use OR-active semantics.
- **Execution is serial:** the nested loop awaits one adapter/local step before considering another (`engine.ts:319`, `:393`). The production worker calls `advanceRun(...maxSteps:1)` and requeues between steps (`worker.server.ts:83`, `:131`), so ready sibling branches are not parallel jobs. Checkpoint publication is awaited before and after execution.
- **Not graph loops:** cycles are rejected. `foreach` creates one list of source-file items (`engine.ts:171`); it does not run downstream nodes once per item. Catalog wording accurately says “Build a batch from all input files” (`catalog.ts:153`), although the label “For each document” can suggest more. AI `iterations` are bounded refinement passes over the same evidence in the adapter (`adapter.server.ts:225`, `:240`), not an evidence-driven multi-agent planning loop.
- **Pause and errors:** the first review/delay pauses the whole run (`engine.ts:356`). Rejection is terminal; approval records reviewer/notes then resumes. A failed step stops the run (`:436`). The engine does not retry a failed result on a subsequent call: it retains the failed step and ultimately cannot progress. The worker separately recovers interrupted `running` steps to pending; completed steps stay immutable (`worker.server.ts:50`).
- **Cancellation protections:** adapter work receives the signal, and late output is rejected if it returns after abort (`engine.ts:395`). Worker ownership/cancellation checks and lease persistence add protection outside this pure engine. Whether particular services honor cancellation belongs to the adapter audit.
- **Completion:** all results completed/skipped → `run.status=completed` (`engine.ts:440`), not a verified requirement/coverage evaluation. Notify produces an explicit unsent draft; no email is sent by the local step (`:204`). Missing services fail rather than fabricate output.

## Findings, ranked

### P1 — Branch control and OR joins are conflated

`incoming.some` (`engine.ts:332`) lets an unconditional active predecessor activate a node whose direct condition edge is unselected. Both live graph validation and the prepared plan validator accept this shape (`graph.ts:88`; `plan-schema.ts:686`).

**Actual reproduction:** Start→Condition(false), Condition.true→Guarded, Start→Guarded, Condition.false→Fallback. The valid graph executes Guarded and Fallback and reports completed. A corresponding authored plan also passes `reviewPlan`; the latter is future-path evidence, not a claim that generation is live.

**Important compatibility detail:** OR-join behavior is intentional in the stock triage graph: summary follows either condition=false or approved review (`seeds.ts:104`–`:106`). Replacing `some` with `every` globally would break that correct route.

**Bounded fix:** distinguish control edges, data dependencies and explicit join policy. A condition-labeled control edge must gate its branch independently of ordinary data prerequisites. Explicit branch convergence may accept one selected branch after all relevant paths resolve. Until the schema supports this, reject ambiguous condition-plus-unconditional-predecessor shapes except validated convergence patterns. Test both the unsafe bypass and the stock approval/skip flow.

### P1 — Source fan-in silently retains only the last source-producing branch

`contextFor` orders every completed ancestor by log order (`engine.ts:261`). `sourceFiles` selects the most recent ancestor object that has `files`, returning only that set (`evidence.ts:56`–`:62`). `merge` nests all ancestor values but does not create a merged `files` collection (`engine.ts:183`). Downstream analysis therefore ignores earlier independent source-producing branches, even after a Merge outputs step.

**Actual reproduction:** two independent fake service nodes each produce one distinct source; both complete; merge→manifest analysis reports one document, B. Reversing node array order makes it report only A. Coverage accurately counts the selected one but never records that another requested branch was omitted.

**Fix:** an explicit source-set union reducer over the selected direct predecessors, deduplicated by immutable source identity/version, with original selected-vs-consumed inventory. Keep an intentional replace-source operation separate. Output must be invariant under equivalent node ordering and execution completion order. This is required before introducing parallel scheduling.

### P1 — Merge can lose final findings and grow serialized state exponentially

Merge copies **all** ancestor outputs (`engine.ts:183`, `:262`), including earlier nested merge objects. Meanwhile `lastText` only looks for a top-level `.text`, so document/notify/response output skips a merge object and selects whichever preceding text result is most recent (`engine.ts:95`, `:192`, `:213`).

**Actual reproductions:**

- Text A + Text B→Merge→Response retains both inside merge.output but final response contains only B, with run completed. There is no explicit partial-output warning.
- A linear chain after a 512-character text has serialized merge output sizes: merge1 **529** chars; merge4 **4,274**; merge7 **34,234**; merge10 **273,914**. Every new merge copies the ancestor closure again. Persisting/model-serializing this state can hit size/time limits far below the 80-node cap.

**Fix:** pass direct predecessor references to explicit reducers; store large immutable outputs once. Make final deliverables name their source output(s) or reducer explicitly rather than choose the most recent text. A merge can produce structured items plus a deterministic display representation without recursively duplicating history.

### P2 — Selected context is validated but not honored at runtime

`graph.ts:118` validates configured context names and `plan-schema.ts:105` exposes them. `contextFor` nevertheless passes all completed ancestors (`engine.ts:262`), and the drafting adapter serializes all non-input/non-file ancestor outputs (`adapter.server.ts:204`). There is no `config.context` runtime filter in these paths.

This can leak irrelevant branch text into a draft, make a user-selected context ineffective, and trigger complete-context rejection because unrelated ancestor outputs are included. This is within-run scope confusion, not a demonstrated cross-user leak.

**Fix:** make selected context the explicit data dependency contract, with a documented default when empty. Always supply deterministic provenance/coverage metadata separately. Validate that a selected output actually ran; absent/ambiguous required inputs should fail or ask for resolution rather than become a literal `[Missing: ...]` prompt fragment (`engine.ts:37`). Coordinate with the adapter owner.

### P2 — DAG shape suggests more parallelism and iteration than execution provides

Independent nodes run serially; a review/delay on one branch blocks an unrelated ready sibling. `foreach` is enumeration and there is no per-item progress, retry, result join, or item checkpoint. Engine `maxSteps` is a per-invocation yield limit, not a multi-round research budget.

**Actual reproduction:** two independent fake service steps reach maximum active concurrency **1**; three foreach items execute the downstream prompt **once**; an early review leaves an independent text branch pending. An already-aborted signal passed to a waiting run returns waiting because the waiting-state prepass executes before the abort check (`engine.ts:303`, `:315`, `:321`). This last observation is the pure-engine boundary, not proof that production repository cancellation fails.

**Fix:** a ready-node scheduler with explicit per-run/per-tenant/per-model concurrency and deterministic join semantics. Model bounded per-item maps as child jobs with item-specific context, operation identity, partial outcomes and resumable checkpoints. Review/delay should block only their dependent subgraph unless explicitly declared a global gate. Check cancellation before waiting-state handling. Do not turn cycles into unlimited model loops.

### P2 — Final report selection needs an explicit output identity

The engine's final response chooses latest ancestor text, while the parent UI audit found `AppStudio.tsx:66` choosing the first top-level analysis report. Those rules can disagree.

**Actual reproduction:** a valid customized graph with parties→chronology recipes completes with two top-level reports; final response starts “Source chronology”, while the first report is “Parties & people”. Stock mini-app factory currently creates one analysis action (`app-templates.ts:286`), so this is a reachable Builder/customization defect rather than a claim every stock mini-app already has multiple reports.

**Fix:** publish a final-output manifest naming selected report/artifact/result node IDs and revision. Display and export that same manifest, while retaining prior outputs as history. Do not infer finality from object insertion order or first matching type.

### P2 — Large-report completeness is limited to a display/export prefix

`makeReport` keeps only the first 1,200 rows (`evidence.ts:102`), with total/shown coverage and an honest warning. Recipe CSV artifacts serialize this shortened report (`recipes.ts:508`), so the cap limits the downloadable findings too. The warning asks users to narrow inputs; there is no report-page continuation contract here. The engine can still mark the run completed.

Other deterministic recipes have deliberate extraction limits: issues uses 25 terms (`recipes.ts:192`), custom field extraction 20 fields (`:466`), and local comparison consumes the first two files (`:355`). These are not general exhaustive semantic analyses. Multi-file comparison accepted by the generic input policy must disclose which pair was actually used; output coverage must not imply all files were compared.

**Fix:** preserve the complete structured result in bounded pages/artifacts, limit only the rendered preview, and carry partial/complete coverage into the final manifest. Validate input arity and requested-field count rather than silently ignore accepted extras. Keep deterministic candidate analysis clearly separated from independently checked model findings.

## Validation and policy notes

- `policy.ts` has useful deterministic ownership/group controls, separate run privacy, exact review-email matching, same-origin JSON mutations, source-warning acknowledgement, and bounds. Preserve these; JEV must never replace them.
- `registers.ts` provides physical-line-preserving CSV/TSV parsing and bigint monetary conversion. Search found no production caller in the current workflow modules. Treat these as prepared helpers, not an active financial computation capability. No financial workflow accuracy claim follows from their existence.
- `recipes.isAnalysisReport` validates shape, not evidence entailment or complete provenance (`recipes.ts:38`). A custom adapter probe with an invented negative-line report was accepted by the engine. Production `createGroundedAdapter` does perform additional evidence validation, so this is a boundary requirement for future adapters, not a demonstrated production fabrication path.
- Recipe notes correctly disclose keyword/format analysis limits; local notify explicitly says not sent. Do not weaken those truthful capability distinctions while improving prompts.

## Bounded implementation order

1. **Pin execution semantics:** explicit edge/join policy, source-set reducers, context selection, final-output manifest. Add the above actual-module regressions before changing scheduler concurrency. Preserve the stock triage review flow.
2. **Remove redundant state:** immutable output references, direct-parent inputs, bounded materialization, complete evidence inventory and paginated result/export storage. Measure serialized run size as well as model input size.
3. **Introduce bounded ready-node execution:** begin with independent read-only nodes and deterministic tools; keep mutations, reviews and dependent edits ordered. Use one owner/lease per node or child job and one shared concurrency/attempt budget. Persist successful work once; classify failed/partial/cancelled outcomes and suppress late publication.
4. **Add genuine map/reduce and bounded repair rounds:** per-document immutable contexts, explicit dependency/barrier contracts, coverage-driven repair with hard round/time/request caps, progress detection and resumable checkpoints. Stop with honest partial coverage when budgets expire; never automatically replay uncertain writes.
5. **JEV exclusively through authenticated AgentCore Gateway→dedicated adapter:** use one compact typed classification batch for intent, task decomposition hints, independent-read grouping, likely relevant capability families and escalation hints. Validate enum/probability shape and contradictory decisions, pin model/rubric/cache identity, and use deterministic conservative fallback on timeout/abstention. Keep Bedrock for generation/planning where needed. JEV cannot authorize tools, omit required source branches, supply factual findings, decide revisions, or certify completion. No direct production TypeSafe request from workflow code.
6. **Acceptance:** multiple input branches retain every required source; equivalent node ordering produces identical scope; false guards never run protected steps; review convergence still works; repeated merges grow linearly; foreach item counts match executed/failed/skipped children; cancel and resume do not duplicate acknowledged work; displayed report and exported artifact use the same final manifest.

## Tests and measured evidence

- `tests/workflows-unit/core.test.ts:114`: awaited checkpoints and no replay of completed steps; `:133`: assigned reviewer and resume; `:156`: missing services fail; `:174`: warning acknowledgement and upload plus pasted context; `:200`: native Word source evidence; `:251`: invented quote rejection by the grounded adapter. These do not cover multi-parent control joins, merged source union, repeated-merge growth, or multiple final reports.
- `plan-schema.test.ts` covers template round-trips, supported vocabulary/settings, schedules disabled on materialization and basic defects. This is prepared generation-contract coverage, not a live generation/AgentCore guarantee.
- `engine-probes.ts` imports actual pure engine, graph, plan and recipe modules; adapters return fixed synthetic outputs. `engine-results.json` records all cases above. No model transport or cloud APIs were imported/called by the probe. Assertions intentionally reproduce current behavior; they are not passing post-fix acceptance tests.

Application repository remained unchanged. Actual deployed performance, worker infrastructure limits, connector cancellation, and model grounding quality require separate authorized validation.
