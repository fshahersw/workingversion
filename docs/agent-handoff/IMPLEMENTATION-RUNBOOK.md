# Research, Discovery and Workflows implementation runbook

This is a continuation guide for a coding agent working from the delivered default branch, `feat/frontier-ux`. Read the [handoff index](README.md) and applicable detailed audit first. Research/Discovery reference `f06e148fdda93553718621ab3634ce53548d7bfe`; Workflows references `0afb944b739406e1e3327e589431ac16f4ad4eb1`. Inspect current source and existing edits before acting. Findings may have been fixed since those checkpoints. Frontier remains excluded despite the historical branch name.

## 1. Establish the checkout and validation baseline

```sh
git status --short
git branch --show-current
git log -5 --oneline
git diff f06e148fdda93553718621ab3634ce53548d7bfe -- src/lib src/routes infra
```

Use a reviewable `codex/` implementation branch from the delivered branch. Preserve other contributors' changes. Use the checked-in dependency/lockfile setup; do not upgrade framework or model dependencies opportunistically. Check Node, Bun and Python availability; some existing extraction tests invoke `python` directly. Read local setup in the Office handoff before starting services.

Identify the active call chain from UI/route to server/client/storage for each finding. Do not optimize a dormant helper because its name matches the task. Working Set Ask currently uses indexed retrieval; its old full-text-scan control is disabled. Tabular Review still defaults to full scan. Deposition covering analysis uses `/api/pile/ask` with analyze mode. Frontier Research is retiring and excluded.

Record a baseline of stage latency and quality before claiming a speedup. Local unit tests cannot establish AWS model availability, quotas, IAM, applied migrations or deployed behavior. Perform authorized environment checks separately and record effective configuration without secret values.

## 2. Non-negotiable implementation contracts

- Derive principal/ownership server-side. Validate document, chunk, workspace, table, row and column scope before using data or committing results. Model routing and caches cannot override authorization.
- Dispatch only completed, schema-valid model tool calls. One accepted call has one terminal result. No execution from truncated streams, malformed JSON, duplicate identities or an invalid stop reason.
- Propagate a single deadline and cancellation context across model streams, tool calls, database requests, response bodies and backoff. Discard stale completions after cancellation or source/run revision changes.
- Preserve immutable evidence identities and versions. Keep original page inventory, authentic page/line coordinates and per-page coverage. Missing or unreadable is not empty; retrieval failure is not absence; quote matching is not semantic support.
- Use conditional revisions for all shared writes, including manual edits and verify/unverify. Preserve the existing Office revision protocol and review manual-edit protections.
- Keep `supported`, `contradicted`, `insufficient`, `unavailable`, `unchecked`, `partial` and `complete` distinguishable. Neither valid JSON nor a successful HTTP response proves exhaustive analysis.
- Jev supplies probabilistic typed judgments. Code owns deterministic constraints, arithmetic, dates, dependency order, coverage, completion and safe fallback. Production vendor calls go through AgentCore; credentials and firm data do not belong in source or ordinary logs.

## 3. Ordered implementation packets

### Packet A: active Research integrity

Read `src/routes/api/orchestrate.ts`, `src/lib/agents/research-agent.server.ts`, `bedrock-stream-tools.server.ts`, `typesafe-questions.ts`, `effort-router.server.ts`, `tools.server.ts`, `faithfulness.server.ts` and `src/lib/fact-check.ts`.

Reproduce and fix incomplete tool-stream dispatch, contradictory conversational/no-tool routes, omitted trailing user requirements, uncancelled tool timeouts, pooled wrong-source number checks, missing ISO-date checks, and `NOT_ADDRESSED` counted as supported. Use the Office stream validator as a proven reference, with explicit cross-surface regression coverage when extracting shared code.

Exit: invalid tool streams execute zero calls; current-information/artifact requirements cannot be down-routed away; late results cannot mutate accepted evidence; every material checked claim links to the right source span/version and honest verification state.

### Packet B: Discovery evidence and write integrity

Read the three subsystem audits and their source references. Fix lossless transcript continuation parsing and authentic citations, mixed-scan extraction coverage, BDA segment/page identity, stale automatic cell writes, verify/override races, silent list truncation, fuzzy source misquotation and CSV formula handling.

Exit: every source page is accounted for or explicitly unresolved; no invented printed line coordinates; older work cannot replace newer work or a manual correction; long lists are complete or explicitly paginated/incomplete; exports preserve literal content and uncertainty.

### Packet C: durable state, recovery and context

Research: version source observations, preserve user constraints through compaction, separate historical/current retrieval policy and event/publication/effective/retrieved/as-of dates. Remove the blanket freshness assumption. Source refresh must update the writer's actual evidence snapshot.

Discovery: persist source/extraction/OCR manifests and idempotent section jobs/results. Align text and BDA retry/lease/reconciliation behavior. Fail run creation explicitly before model work. Persist and rehydrate OCR provenance and expected page coverage. Use token/byte-aware chunks and source-set budgets without silent tail cuts. Repair Working Set follow-up UI and latent reusable-source API limits together.

Exit: browser refresh or worker restart resumes acknowledged work; storage/model outages produce typed recoverable states; repeated questions with changed source or as-of context do not reuse stale evidence; reopened output retains original coverage and provenance.

### Packet D: bounded parallel throughput

Research: batch routing work with memory I/O, start scoped independent workers when requirements justify them, share one nested tool budget, remove unnecessary second classifications and throwaway final drafts. Consume immutable tool results incrementally without treating fastest arrival as best evidence.

Discovery: replace quadratic deposition batch comparisons with candidate generation plus original-source verification and coverage-aware reduction; scope intermediate summaries and synthesize the corpus last. Share extraction/page reads and stable retrieval preparation across Review columns. Evaluate small compatible question bundles while preserving separate outputs and checks.

Both: weighted global/per-tenant/per-model concurrency, one retry/attempt budget, correct Retry-After handling, removable limiter waiters, bounded queues, explicit cancellation ownership and deterministic aggregation. Do not raise caps before measuring throttling and tail latency.

Exit: seeded distant contradictions and required values remain discoverable; completion order does not change output scope; acknowledged work is reused; quality meets baseline with fewer redundant calls and improved measured latency.

### Packet E: AgentCore-mediated Jev

Follow [Office handoff section 5](../office-external-agent-handoff.md#5-first-follow-up-put-jev-behind-agentcore). Share a narrow authenticated adapter and validated decision contract, while preserving separate rubrics and ownership per surface. Gateway Lambda calls the external TypeSafe API; it is not locally hosted model inference.

Batch independent typed questions over compact complete task state. Preserve explicit instructions, selected-source scope, as-of date and coverage gaps. Validate enums, finite probabilities/confidence, model/rubric version, deadlines and contradictory heads. Deterministic policy vetoes unsafe no-tool or incomplete routes. Timeout, uncertainty and invalid output use conservative existing paths. Do not add a direct production vendor bypass.

Run shadow decisions without delaying the chosen path; use supported durable telemetry if it must outlive a request. Measure gateway/adapter/vendor cold and warm latency and routing accuracy on held-out cases before promotion. Do not replace mechanical calculations or exact checks with Jev calls.

### Packet W: Workflows integrity, recovery and parallel execution

Read the [Workflows overview](workflows/WORKFLOWS-ORCHESTRATION-REVIEW.md) and all three subsystem reports. Trace `WorkflowsPage.tsx`/`AppStudio.tsx` → `api.server.ts` → `repository.server.ts`/`worker.server.ts` → `engine.ts`/`adapter.server.ts` under `src/lib/workflows`, plus the worker infrastructure template. Treat `plan-schema.ts` and `registers.ts` as prepared helpers until an active caller is established.

Implement in this order:

1. Repair source fan-in, direct-parent merge semantics, final-output identity, context selection, atomic skill application, exact docket/Python contracts and lossless report/native export content. Preserve stock triage OR convergence while separating control gates from data edges; a global OR-to-AND change is incorrect.
2. Separate checkpoint/ownership/transport faults from task failure and user cancellation. Bind stable admission keys to immutable request fingerprints; retain client keys across ambiguous retries. Make outbox processing fair and paginated; reserve model-call slots before dispatch and abort/drain failed pools.
3. Store outputs once by reference, checkpoint/cache extraction by source/parser/schema/model/task identity, and expose revisioned lightweight status/events. Do not repeatedly serialize all ancestor results or transfer full sources just to show progress.
4. Add per-node leases and bounded ready-node scheduling, then actual per-file child jobs with per-item retry/coverage and explicit joins. Preserve approval permissions and isolate dependent review gates. Measure shared tenant/model concurrency before increasing caps.
5. Add resumable plan/execute/verify/repair rounds with progress detection, hard deadlines and request/token budgets. Route compact semantic decisions through the shared AgentCore Jev adapter from Packet E; code remains responsible for authorization, branch readiness, arithmetic, coverage and final completion.
6. Verify the same final-output manifest through UI → persistence → Writer → reopen → DOCX/PDF/CSV. Paginate presentation without discarding canonical findings. Expose partial coverage and unavailable tools; a completed graph is not proof that all requested findings were verified.

Parallel coding ownership can be split across engine/dataflow, backend durability, tool/export contracts and UI, after agreeing on source/output/job schemas. Give shared schema and budget changes one owner. In particular, do not race multiple workers against whole-run snapshot replacement.

Required regressions: branch-order-invariant source union; false guard plus unconditional predecessor; valid triage merge; ten chained merges with linear growth; 1,201 findings including a critical last row; paired citations and comparison narrative in downloads; Python default execution; lost start response; changed replay payload; checkpoint and cancellation-read faults; 101 persistently due runs; pool failure and 199/200-call race; real per-file execution counts; stale status responses; repeated local DST hour; skill instructions surviving renaming. Preserve the audit's distinction between actual-function synthetic probes and real service integration.

Exit: every selected source and output is accounted for; no false cancellation or silent truncation; completed work survives recovery without duplicate publication; joins are correct under varied completion order; final artifacts match saved content; measured speed improves without lowering coverage/quality. Then use bounded synthetic AWS canaries to verify effective configuration, IAM, model access, queue recovery and provider transport cancellation.

### Packet F: end-to-end delivery and release

Restore native Discovery browser startup before interpreting its workflow tests: three audit traces stopped at an unresolved TanStack `process.env.TSS_SERVER_FN_BASE`; a fourth had unresolved startup without a captured identical exception. Inspect framework transforms and resolved client defines. Do not expose server environment through a blanket browser process polyfill. Workflows has a separate recorded catalog-test mismatch; do not assume the Discovery exception explains it. Test the production-built browser bundle separately.

Validate saved/reopened answers, original-file access, source navigation and exports against the same run snapshot. Include partial/unsaved state, revision/model provenance, table/diagram-heavy Office regressions, and safe native types. Release only through the existing authorized environment process with rollback flags and measured quality/performance evidence.

## 4. The required work loop

For every bounded packet:

1. Reconfirm the caller path and state the intended observable behavior. Record assumptions that remain unverified.
2. Turn the concrete audit counterexample into a regression against the real helper/route/storage contract. Use synthetic fixtures and controlled timing for races; avoid tests that merely search implementation strings.
3. Implement the smallest coherent fix and preserve existing safety/ownership checks. Parallelize work only across disjoint files/contracts; assign shared transport/schema changes to one owner.
4. Run focused tests; inject timeout, 429/503, malformed/truncated output, cancellation and stale revisions where relevant. Drain work and inspect durable state, not only the UI message.
5. Test the browser/native route when it owns the behavior, then Save → reload → source navigation → export. Verify file contents and versions rather than just download filenames.
6. Measure latency and quality against the fixed baseline. If a check fails, diagnose, repair and rerun the affected checks. Do not add retries that merely hide a permanent failure.
7. Run shared regression checks once when the packet is stable. Review the diff, update documentation, commit a reviewable result, and record unfinished gates explicitly.

For long sessions, checkpoint the coding agent's progress too: branch/commit, current packet, tests/results, files changed, unresolved hypotheses and exact next action. Distinguish code completed, locally tested, cloud tested and deployed. A budget/time limit is not successful implementation.

## 5. Validation commands and fixtures

From repository root, with Bun and Python on PATH:

```sh
bun test src/lib/agents src/lib/research-intent.test.ts src/lib/fact-check.test.ts
bun test src/lib/pile src/lib/kb src/lib/review
bun test tests/workflows-unit src/lib/workflows
npx tsc --noEmit --project tsconfig.workflows-tests.json
```

Discovery browser suite uses its own Vite instance and refuses to reuse a running development server. Use an unused port and mock API/server-function traffic for synthetic browser tests. Do not run a production build concurrently with the browser suite.

```sh
PLAYWRIGHT_PORT=5197 npx playwright test --config playwright.discovery.config.ts --reporter=line
```

PowerShell equivalent:

```powershell
$env:PLAYWRIGHT_PORT = '5197'
npx playwright test --config playwright.discovery.config.ts --reporter=line
```

The Workflows browser configuration uses port 5175. Ensure it is free and set `CI=1` to prevent reusing an unrelated running app. Its transport fixtures do not establish real AWS or Office save success. Reconcile the stale `Litigation stage`/`Settlement packet readiness` expectation with the current `App category`/mini-app surface before treating the suite as green.

```sh
CI=1 npx playwright test --config playwright.workflows.config.ts --reporter=line
```

PowerShell: set `$env:CI = '1'` before the same `npx playwright test` command. Build fake cloud dependencies with network access blocked from process startup. The original abandoned Workflows backend harness made unintended unsuccessful SDK reads and must not be recreated by copying its mocking approach; see [validation evidence](workflows/validation-evidence.json).

Run the existing Office validation commands from its handoff when changing shared model streams, tool dispatch, routing, file delivery or native dependencies. Use the repository build/type/lint checks appropriate to actual changes; separate existing failures and missing local dependencies from regressions. Run checks sequentially where they share generated build state.

Required adversarial fixtures include truncated tool blocks; contradictory Jev heads; long trailing corrections; stale source refresh; historical/as-of questions; wrong-source amounts/negated clauses; continuation-only testimony; unnumbered Q/A; mixed scanned/text PDFs; failed BDA segments; oversized Unicode paragraphs; lists over 24 items; same-name different witnesses; distant contradictions; verify racing override; old/new run writes; cancel/restart/table switch; model/storage outages; refresh mid-job; wrong-owner IDs; and exports containing formula-leading literal text.

Compare p50/p95/p99 completion and first-useful-result latency, calls/tokens/bytes, coverage, citation/claim correctness, temporal accuracy, routing errors, abstention, resume work repeated, cancellation-to-stop time, saved-write conflicts and export fidelity. Set numerical targets after a real authorized baseline. No latency target justifies omitted evidence or lost user edits.

## 6. Final handoff from the implementing agent

Provide exact branch/commit, changed behavior, validation commands/results, measured speed and quality differences, migration/config requirements, rollback switches, and remaining cloud/browser/Office acceptance. Keep a clear checklist of implemented versus planned work. Do not mark the audits' counterexamples fixed merely because the original broad suites still pass. Do not deploy without the operator's applicable deployment authorization.
