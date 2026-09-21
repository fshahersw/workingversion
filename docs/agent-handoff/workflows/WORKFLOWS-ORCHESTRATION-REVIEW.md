# Workflows: orchestration, accuracy, performance and UX review

Audit date: 2026-09-21. Repository: `fshahersw/workingversion`, branch `codex/office-pdf-quality`, commit `0afb944b739406e1e3327e589431ac16f4ad4eb1`.

**Conclusion:** retain the authenticated AWS persistence, published snapshots, evidence validation and review controls. First repair dataflow, tool contracts, failure classification and output completeness. Then introduce bounded parallel execution and resumable verification loops. Increasing model speed or adding agents before these fixes would make incomplete or inconsistent results arrive faster.

This is a source audit and local verification report, not a production-readiness certification. The audit changed no application files. This documentation delivery publishes the review and recorded synthetic evidence; it does not implement the proposed fixes or deploy the platform. Frontier is legacy and is excluded from the proposed design. Actual AWS deployment state and throughput remain unverified.

## 1. Current platform map

| Layer | Current implementation | Practical implication |
|---|---|---|
| Page and library | Authenticated `/workflows`, native AppShell, 11 mini apps, 6 templates, saved definitions and run history | Integrated product surface, with useful templates rather than a separate prototype UI |
| Builder | DAG editor, forms, conditional branches, context selection, skill picker, model settings, explicit saving, undo/redo, import/export | Several visible configuration controls do not yet match executable behavior; see findings |
| Publication and access | Immutable published graph, conditional saves, owner/group view/run/edit grants; run-only users execute publication | Preserve these boundaries and never let a router substitute its own permission decision |
| Intake | TXT/Markdown/CSV/TSV/JSON, text PDF, DOCX and EML; imported owned workspace text; source hashes and warnings | Browser extraction is not OCR or layout/track-change preservation; email attachments are separate inputs |
| API | Authenticated and same-origin mutations, bounded JSON, definition/run/source/skill endpoints | Capabilities reflect configuration, not a live dependency health check |
| Durable execution | DynamoDB metadata and revisions, private S3 snapshots, SQS delivery, leases, due-work outbox, scheduler | Good recovery foundation, but important failure paths still become terminal or misclassified |
| Engine | Acyclic graph, one completed step per production worker invocation; serial ready-node execution | Independent graph branches are not parallel worker jobs |
| Analysis | Deterministic recipes plus explicit Bedrock extraction/drafting, exact quotation and source-range validation | Grounded quotation is enforced; exhaustive semantic coverage and correct inference require additional verification |
| Outputs | Report table/text, CSV, native DOCX/PDF, save report into existing Writer via `/api/office/docs` | Native bytes are real; complete content and presentation equivalence are not assured |
| Schedules | Daily/weekly IANA timezone; latest published graph, selected prior run's input snapshot | Not a live mailbox/Box subscription; changed graph versions require input compatibility checking |

Key source entry points: [route](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/routes/_authenticated/workflows.tsx), [page](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/WorkflowsPage.tsx), [mini-app templates](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/app-templates.ts), [API](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/api.server.ts), [repository](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/repository.server.ts), [worker](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/worker.server.ts), [engine](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/engine.ts), [production adapter](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/src/lib/workflows/adapter.server.ts), [infrastructure template](https://github.com/fshahersw/workingversion/blob/0afb944b739406e1e3327e589431ac16f4ad4eb1/infra/app/workflows.cfn.yaml).

The mini apps cover plaintiff extraction, chronology, document comparison, citation-component checks, plain-language editing, matter briefs, supplied email briefings/action queues, meeting actions, custom extraction and website change monitoring. Deterministic recipes have deliberately narrower scope than an autonomous research agent. Citation checks are not a citator; supplied email processing is not mailbox integration; notification steps create unsent drafts.

Current bounds include 80 graph nodes, 20 files, 20 MB original file size, 300 PDF pages per file, 500,000 extracted characters per file, 1,000,000 per run, 5.5 MB API requests and 25 MB persisted snapshots. These are input/storage limits, not proven throughput guarantees. The worker has a 13-minute step watchdog and a 15-minute Lambda timeout; successful sub-chunks are not durably checkpointed. The infrastructure template reserves four worker executions. Six chunk calls per active extraction can therefore imply up to 24 simultaneous model calls before other platform traffic; this is a configuration-derived ceiling, not measured AWS concurrency.

The stricter `plan-schema.ts` and CSV/money helpers in `registers.ts` are prepared modules, not wired into the current live workflow generation/execution path. Their unit tests do not establish that their rules govern every saved Builder workflow.

## 2. Confirmed correctness and reliability findings

Priority P1 means fix before expanding production orchestration; P2 means an important capability, performance or experience gap. Evidence labels distinguish actual-module synthetic reproductions from source-only findings. Reproduction assertions deliberately confirm defects; they are not post-fix correctness passes.

### P1: Branch merging loses sources and final text

Two completed source-producing branches feeding Merge and then analysis consume only the most recent branch's `files`. Reversing node order changes the retained source. There is no warning that another requested branch disappeared. A separate A+B→Merge→Response reproduction returns only B as final text.

The cause is a mismatch between all-ancestor context, a last-source selector, nested merge objects and latest-top-level-text output selection. See [engine report](engine-findings.md), `engine.ts:95,183,260` and `evidence.ts:56`.

**Required change:** explicit input ports/source sets, deduplication by immutable source identity/version, direct-parent reducers, and a final-output manifest. Track selected, consumed, excluded and failed sources separately. Equivalent graph orderings must produce identical source scope. Parallel scheduling must not make scope depend on completion order.

### P1: Repeated merging multiplies stored context

A 512-character source becomes a 273,914-character merge output after ten merges because each merge embeds the whole ancestor closure, including previous merged copies. Four merges already produce 4,274 characters; seven produce 34,234. This is actual serialized output, without any model calls.

**Required change:** store each output once and pass references. Materialize only selected direct inputs under a bounded context plan. Measure snapshot bytes and copied bytes per step; a linear chain must have approximately linear, not exponential, growth. This improves both latency and context reliability.

### P1: Control conditions and branch joins are ambiguous

A valid graph with a false condition can still execute its nominally guarded node if that node also has an active unconditional predecessor. Activation uses any active incoming edge. However, the stock triage template intentionally uses OR convergence after its condition/review alternatives.

**Required change:** separate control gates from data dependencies and declare join policy explicitly. Do not globally replace OR with AND. Until typed joins exist, reject ambiguous condition-plus-unconditional shapes while preserving valid triage convergence. Regression cases must include both the bypass and the ordinary review/skip path. See `engine.ts:329–356`, `seeds.ts:104–106` and the engine probe.

### P1: Tool contracts and Python examples disagree with execution

Four approved docket operations use a generic query schema that strips the `case_id` or `document_id` required by their real executors: `db_get_case`, `db_docket_sheet`, `db_calendar`, `db_read_filing`. Parsing can succeed while removing the identifier needed to perform the intended read.

The default Python example reads `context` and assigns `result`, but the adapter only writes `workflow_inputs.json` with `{inputs, values}` and executes raw code. It does not create `context`, serialize `result`, or retrieve generated native files before ending the interpreter session.

**Required change:** maintain one executable tool-contract registry, with exact input/output schemas, permissions, cancellation, retry and artifact metadata. Test each approved operation against a mocked real executor. Define the Python bootstrap/result/file-retrieval protocol and verify the exact UI example. Source: `tool-contracts.ts:66`, `agents/tools.server.ts`, `catalog.ts:232`, `python.server.ts:69`; details in [tools review](tools-findings.md).

The supplied worker infrastructure also omits the AgentCore search and KB runtime variables required by the shared connected-tool implementations. Attaching policies alone does not configure those endpoints and database connections. This is a source-confirmed deployment-template gap; the live Lambda environment may have additional configuration and was not inspected. Add explicit stack configuration and a template-to-runtime contract check before claiming connected-tool readiness. See `infra/app/workflows.cfn.yaml:148–158` and the [backend review](backend-findings.md).

### P1: Complete-looking reports and exports can omit material content

Actual native-output and report probes found:

- Row 1,201 is discarded when `makeReport` slices to 1,200. A warning and original count survive, but the remaining finding is unavailable to pagination, downstream work or download. This is disclosed truncation, not merely a display cap.
- Comparison narrative present in report text is absent from the DOCX XML, although the evidence table survives.
- CSV omits paired secondary evidence references and end-line locators.
- A long unbroken token produces a 1,510.4-point PDF text run on a 612-point page; bytes are returned successfully but content extends off-page.
- A customized parties→chronology workflow has a final chronology response, while the mini-app UI selects the first report, parties. Stock mini apps normally contain one analysis report; this mismatch is reachable through customization.

**Required change:** one complete structured report representation and final-artifact manifest for UI, persisted data, Writer, DOCX, PDF and CSV. Paginate the view, not the canonical findings. Retain all narrative sections, both sides of comparisons, qualifiers and locators. Test native bytes and rendered bounds; a successful HTTP response or ZIP signature is not sufficient. See `evidence.ts:77,102`, `files.ts:132,160`, `AppStudio.tsx:65`, and [tools results](tools-results.json).

### P1: Transport failures, retries and cancellation need distinct states

Isolated actual-function backend probes show:

- A transient checkpoint write error becomes a failed step/run rather than retryable infrastructure failure.
- A temporary cancellation-poll read failure produces a terminal cancelled run without a user cancellation request.
- Reusing an admission request ID with changed inputs returns the old run instead of a conflict. The server needs payload/version binding.
- The client has the opposite failure mode: after a response is lost following admission, retrying generates a new request ID and can admit a second logical run.
- With 101 persistently due records, two outbox ticks enqueue the first 100 twice and never reach record 101. The static fixture demonstrates starvation risk under sustained backlog; it is not a measured production incident.

**Required change:** distinguish user cancellation, lost lease, transient storage/transport failure, permanent input failure and exhausted execution budget. Bind stable admission keys to workflow/version/input hashes; retain and reconcile them in the client. Use paginated/fair outbox processing and leases or dispatch markers. Preserve completed work and classify uncertain side effects before retrying. See [backend results](backend-results.json), [UI results](ui-results.json), and the subsystem backend report.

### P1: Failure does not stop chunk dispatch or enforce the stated budget

When one of twelve chunk calls fails, the step rejects after six calls start, but the pool ultimately invokes all twelve; eleven finish after rejection. Separately, six calls admitted with 199 prior requests complete at 205, exceeding the stated 200-call run cap because accounting happens after awaiting the call. Failed transport attempts are not included in the successful-request counter.

**Required change:** reserve slots before dispatch, track attempted/completed/failed calls, stop new work on fatal error, abort and settle siblings, then persist accounting. Introduce durable per-chunk results to avoid paying again for already completed work. Propagate cancellation through research executors as well as model/scrape/KB/Python transports. See `grounded-adapter.ts:95`, `adapter.server.ts:76,92,409`.

### P1/P2: Skill application and context controls are unreliable

The actual skill-selection callback issues two replacements from the same captured step. For a default-labeled prompt, the first inserts instructions; the second renames the step and restores the old empty instructions. The isolated callback reproduction confirms two updates and a final empty instruction field.

The context checkboxes are stored and validated but are not used by runtime context assembly. All completed ancestors are supplied instead. This is within-run scope confusion; no cross-user exposure was demonstrated. The skill corpus has 146 entries, 14 ending in an ellipsis, including an acceptance checklist cut mid-entry. Instructions are prompt text, not enforced execution contracts.

**Required change:** atomic skill application, version/hash provenance for complete skill bodies, runtime context selection with clear empty-selection semantics, and separate machine-enforced acceptance rules. See `StepInspector.tsx:397,403`, `WorkflowsPage.tsx:765`, `engine.ts:260`, UI probes (recorded locally; see [validation evidence](validation-evidence.json)), and the tools review.

## 3. Speed and capability gaps

These are concrete differences between the current engine and the requested intelligent, parallel workflows:

- Independent ready nodes run serially. The worker checkpoints and requeues after one step, including cheap deterministic steps. Model chunking has limited parallelism; graph execution does not.
- “For each document” builds a list. Three input files result in one downstream prompt execution, not three independently checkpointed child workflows.
- The agent block is a configured draft/refinement call. Its allowed-tool-group control does not invoke a tool loop; the adapter prompt says no external tools are available.
- Refinement runs one to four passes over the same evidence. It does not provide independent verification, coverage-driven gap filling or durable long-loop progress.
- A review/delay on one branch pauses the entire run, including unrelated ready branches.
- Each drafting step can repeat extraction of the same sources. There is no durable per-chunk reuse across later steps/retries.
- The page polls full run objects every four seconds for watched/open runs. Large source/result snapshots are repeatedly transferred for status changes. Upsert has no monotonic run-revision guard against stale responses.

Model tier, token and refinement settings **are active** for prompt/agent/edit: 512–32,768 output tokens, one to four passes, fast/balanced/deep mapping. Preliminary extraction uses the research model and 16,384 output tokens regardless of draft tier. Current source chunks are 48,000 characters with a six-call pool. README statements of 12,000-character chunks and universal 8,192 output tokens are stale. These facts matter when diagnosing why choosing a fast drafting tier does not make the whole workflow fast.

## 4. Target orchestration

Keep the existing API, ownership, publication and AWS services. Evolve their execution contract in small, testable stages:

1. **Admit:** validate caller access, published revision and exact input contract. Freeze run time, requested as-of time, timezone, source versions, instructions/schema versions and a logical operation ID.
2. **Plan:** form a typed dependency graph with explicit input/output ports, control gates, join policy, capability requirements and budgets. A model may propose a plan; deterministic validation admits it.
3. **Schedule:** dispatch only ready nodes, with per-run, per-tenant and shared model/tool concurrency limits. Separate node leases and compare-and-set output publication avoid concurrent workers rewriting the whole run snapshot.
4. **Execute:** use code for parsing, filtering, hashing, date normalization, arithmetic, deduplication and formatting checks. Use Bedrock for semantic extraction, synthesis and difficult reasoning. Store outputs once by immutable reference.
5. **Verify:** check source coverage, source identity, quotation/range validity, requested fields, contradictions, artifact completeness and task-specific acceptance rules. A model verifier can assess inference quality; deterministic checks still enforce measurable constraints.
6. **Repair:** schedule only missing/failed portions. Persist completed chunks, attempt history and coverage gaps. Stop on no progress, repeated identical failure, deadline, request/token budget, or required human review. Return an explicit partial/needs-review outcome when necessary.
7. **Publish:** select final outputs explicitly and generate all formats from their shared representation. Verify export content and revision. UI “completed” should distinguish execution completion from verified output coverage.

Each child job should carry run/node/item IDs, input/output hashes, attempt number, lease token, schema/skill/model versions, source references, deadline, reserved budget, status, and artifact references. Approval remains a persisted, authorized human decision. A review gate normally pauses its dependent subgraph; an explicit global gate can pause all work when the workflow requires it.

For real per-file processing, build bounded map/reduce: child jobs for individual immutable file contexts, per-item retry/cancellation/coverage, then an explicit join over successful and failed items. Complex asks need resumable state machines around that graph, not unrestricted graph cycles or ever-growing conversation transcripts.

### Jev through AgentCore Gateway

Required production path: **Workflow worker → authenticated AgentCore Gateway tool → dedicated Lambda adapter → TypeSafe API**. The adapter owns the secret, deadline, compact input/output schema, validation, telemetry and fallback. No direct TypeSafe credential or production call from the browser or general workflow executor. This path is proposed; no current Workflows Jev integration was found.

Use Jev for frequent compact decisions: intent family, relevant capability candidates, extraction strategy, escalation hints, evidence-gap class, and candidate next actions. Independent questions over the same small state can be requested together. The host resolves contradictions and validates the result against the actual graph, available tools and policy. Jev output is model-generated classification, not intrinsically deterministic truth. Cache only under exact scoped input/rubric/model/source identities, and use conservative fallback on timeout or invalid/uncertain output. The [TypeSafe introduction](https://docs.typesafe.ai/introduction) describes typed questions and parallel independent decisions; [AWS Gateway Lambda target documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html) describes the tool-schema/adapter boundary.

Do not spend a Jev call on deterministic graph readiness, permission checks, hashes, arithmetic, fixed format rules or already-known input types. Do not let classification certify evidence completeness, bypass review, or decide which required sources can be silently dropped. Measure whether routing saves total latency for each task class; parallel inference still has network overhead and error rates.

### Context and temporal awareness

Use a small execution state plus fetchable evidence references instead of recursively passing all prior outputs. Pin required instructions, user constraints, pending decisions and unresolved contradictions. Pack model context by actual model budget, selecting cited excerpts and bounded structured intermediate records. Preserve exact quotes and provenance separately from compressed summaries.

Record execution time, user-requested as-of time, source publication/event/effective dates, retrieval time, timezone, and baseline identity as distinct fields. Schedules currently reuse old input snapshots with the latest graph; validate compatibility and disclose input freshness. The scheduler probe reproduces two occurrences of the same local 01:30 during the DST fall-back hour. Define an explicit once-per-local-date versus twice policy; defaulting to once is a proposed product decision, not a statement of current behavior. Missing monitoring baseline must remain “baseline established,” never “no change.”

## 5. Implementation order and verification loops

| Stage | Work | Exit evidence |
|---|---|---|
| 1: Integrity | Source union, explicit final output, context selection, skill update, exact tool/Python contracts, complete canonical reports/exports | All demonstrated counterexamples converted into passing regressions; stock triage behavior preserved |
| 2: Recovery | Stable admission identity, transient/permanent error separation, cancellation reasons, fair outbox, atomic call budgets, sibling drain | Fault injection shows no duplicate logical runs, no false user cancellation, no starvation, no post-failure dispatch |
| 3: Efficient state | Immutable artifacts, direct input references, cached versioned extraction, status/event API with revision guards | Linear snapshot growth; no repeated full-file status polling; measured reduction in repeated work |
| 4: Parallel work | Per-node leases, ready-set scheduling, per-file child jobs, tenant/model governors, scoped review gates | Correct joins under varied completion order; cancellations/resumes preserve exactly-once publication of completed outputs |
| 5: Intelligent rounds | Gateway Jev adapter, bounded Bedrock tool loops, source-gap repair, independent semantic checks | Routing confusion matrix, quality/coverage non-regression, bounded latency/cost and graceful fallback |
| 6: Product completion | Honest capability labels, all-output navigator, partial-result/coverage UI, export previews and save/reload checks | Browser actions match persisted revision and downloaded content on desktop/mobile |

For every stage: capture a failing regression first, implement a bounded change, run targeted tests, inspect actual persisted/native outputs, inject a relevant failure, then review against the pinned acceptance criteria. Repeat only for a new failure or a changed dependency. Avoid measuring speed on a workload that has silently omitted sources or rows.

Benchmark short and long workflows, branch joins, 20-file inputs, a 1,201-row report, long identifiers, source warnings, duplicate delivery, lost start responses, throttling, mid-chunk failure, worker interruption, review/resume, stale client polling and DST boundaries. Include concurrent tenants and varied graph completion orders. Record p50/p95 first useful result and final verified artifact times, model/tool attempts, token counts, byte movement, checkpoint overhead, repeated work, source/field recall, false-completion rate and artifact equivalence. Establish a baseline before choosing numeric speed targets or increasing concurrency.

Production canary validation must use synthetic data, actual deployed IAM/queue/storage/model settings and bounded concurrency. The AWS SQS integration needs delivery/failure behavior checked against its deployed settings; see [AWS SQS error-handling documentation](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html). No production load, live legal correctness, or model-latency result was established in this audit.

## 6. Verification performed and limitations

- Focused workflow tests: **71 passed, 0 failed, 184 expectations across four files**. Commands and recorded outcomes are in [validation evidence](validation-evidence.json); raw logs remain local.
- Workflow TypeScript project: `tsc --noEmit --project tsconfig.workflows-tests.json` **passed**.
- Existing browser suite: **4 passed, 1 failed**. The first run failed at page-heading startup. A targeted rerun reached the rendered library and then failed because the test requests a `Litigation stage` control and `Settlement packet readiness` template, whereas the current library exposes `App category` and 11 current mini apps. The later failure is a stale test expectation, not evidence of a missing current category control. The first startup timeout was not independently explained. Logs and browser traces remain local; the failure classification is retained in validation evidence.
- Passing browser scenarios covered Builder save/publish/share/run, save-conflict handling, mini-app upload/native DOCX/mobile, and feature gating/unauthenticated API handling. Browser workflow transport is fixture-backed and uses the pure engine; it does not validate DynamoDB/SQS/Bedrock or the live Office save service.
- Engine/tool probes import actual pure modules; UI/backend probes also extract actual function bodies with injected dependencies. These are synthetic reproductions, not full service integration tests. Results: [engine](engine-results.json), [tools](tools-results.json), [UI](ui-results.json), [backend](backend-results.json).
- **Probe safety exception:** an initial backend harness failed to intercept SDK dependencies. Four failed test paths made unintended DynamoDB read/query transport attempts and stopped at TLS certificate verification; the exact SDK wire retry count was not captured, and no successful AWS operation was observed. That harness is invalid evidence and is disabled. Replacement backend probes explicitly block HTTP/HTTPS/fetch and recorded zero network attempts. No claim of live AWS validation or intentional AWS changes is made.
- The repository README contains conflicting deployment wording and stale model bounds. Repository configuration and documentation do not prove what is currently deployed at testing.seegerweiss.com.

For detailed evidence and exact code anchors, read [engine findings](engine-findings.md), [tool/evidence/export findings](tools-findings.md), and [backend findings](backend-findings.md). The accompanying [validation evidence](validation-evidence.json) records source identity, commands, methods and limitations. Original local scripts, raw logs, disabled harness and browser traces are deliberately not published; turn the described cases into portable regressions before implementing fixes.
