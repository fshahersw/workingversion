# Discovery and Office integration handoff

Prepared September 12, 2026 for `fshahersw/workingversion`, branch `codex/integrate-discovery-office`.

## Scope and acceptance contract

Base: `feat/frontier-ux` at `fa0236939327f993ed2c81248d9e18dd83df648a`. Apply the reviewed Discovery and Office changes on an isolated checkout; preserve the current platform's Research behavior and authentication. Fix Office Python continuity across workers, keep unverified voice off, validate the combined code, and submit a draft PR. No MCO application, mock production datasets, credentials, or local environment files are part of this integration. Existing Workflows features in the base remain in place.

The original development checkout is preserved. The only conflict when constructing the candidate was in the shared Research `dbReadFiling` path; the combined version retains current-head SourceBook `fullText` support alongside the Office changes. No published commits are rewritten. A clean Git merge or successful local build alone is not production acceptance.

| Area                         | Included changes                                                                                                                                     | Review focus                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Discovery                    | Deposition save recovery, evidence-aware graph and mapped insights, smooth focus, section exports, intake reporting                                  | Save/reopen without a second analysis; citation provenance; no inferred graph edge presented as a quotation |
| Working set / tabular review | Explicit scan coverage, retry/cancellation boundaries, complete document scans, suggested columns and review write reliability                       | Failed or partial coverage remains visible; findings stay attached to the actual source document            |
| Writer / Sheets / Slides     | Exact edits, bounded document access, complete extraction pages, large original-file uploads, source/diagram access, read concurrency, user steering | Native document structure/undo; attachment ownership; stale pagination and cancellation                     |
| Python continuity            | Durable task registry, exclusive operations, conservative failure handling                                                                           | Same owner/task resumes on another worker; unknown outcomes never trigger automatic code replay             |
| Voice                        | Separate real Bedrock gateway and Office companion, server-controlled default-off gate                                                               | Must remain disabled outside intentional staging until live acceptance passes                               |

## Durable Office Python design

`interpreter-registry.ts` coordinates each Office operation. `interpreter-store.server.ts` uses the existing app DynamoDB table, `PK=USER#<verified principal>`, and a versioned `OFFICE_PYTHON` sort key derived from interpreter region/identifier and task scope. Each operation loads the saved session ID, creation time, known files and artifact baseline. No Office session identity depends on the current Lambda's memory. Research retains its prior owner-scoped, process-local workspace; Research conversation-level durability is outside this fix.

Conditional updates acquire exclusive access before any sandbox action. Session creation is checkpointed before uploads or execution. Complete Office operations retain ownership through writing, running and artifact collection; nested sandbox RPCs also serialize. A final conditional write persists metadata and releases the claim. A lost final-write acknowledgment is accepted only when a consistent read proves that exact operation's completion token was committed. `snapshot` is aliased in expressions because it is a DynamoDB reserved word.

- Acquisition can retry briefly before any side effect. AgentCore SDK retries are disabled (`maxAttempts: 1`); executable Python is not automatically replayed after a transport failure.
- Confirmed `failed` and `canceled` results are completed errors, even when AWS omits `isError`; users can correct them in the same session. Empty, unfinished, exception-bearing or interrupted streams block future work on that task.
- A claim lasts 20 minutes, exceeding the application's 15-minute Lambda maximum. An abandoned claim is never stolen: remote code may still be running. The user starts a new task and reattaches its inputs.
- Remote sessions have a 30-minute absolute TTL; the app reports expiry at 28 minutes. It does not silently replace a lost Office session. Closing a temporary workspace persists a tombstone and stops the remote session on a best-effort basis.
- Registry records/tombstones expire after seven days via the table's existing `ttl` attribute. TTL deletion is asynchronous and is not a lease-release mechanism. Clients must keep issuing fresh task UUIDs; this is not indefinite deduplication of old task IDs.
- Metadata is capped below the DynamoDB item limit. Tracking overflow or failed persistence cannot return a successful, reusable workspace.

No table, index, data backfill or root runtime dependency was added. Tracked infrastructure already enables `ttl` and grants the application DynamoDB GetItem/UpdateItem; deployed configuration and IAM still require verification. The registry stores metadata, not document bytes, Python variables, audio, or model reasoning. The remote interpreter continues to own its files and memory.

This is session continuity and operation coordination, not a durable job queue or a general exactly-once browser request protocol. Closing the editor still does not guarantee job completion. A completed server response lost on the way to the browser cannot be reconstructed as an entire user conversation by this registry. Keep tasks open and use explicit status/error handling.

AWS references: [AgentCore session state and expiry](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html), [InvokeCodeInterpreter stream contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeCodeInterpreter.html), [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html), and [asynchronous TTL deletion](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html).

## Local validation

All tests with external-service substitutes keep those substitutes in test code; production continues to use authenticated real services.

| Check                                               | Result                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Platform unit suite                                 | 558 passed across 92 files                                                                                                                |
| Existing Workflows contracts                        | 30 passed                                                                                                                                 |
| Actual Python adapter with controlled SDK transport | 6 passed; confirmed failures remain usable, uncertain execution blocks replay                                                             |
| DynamoDB protocol and separate-process continuity   | 7 passed on a real loopback emulator using the AWS SDK                                                                                    |
| Voice gateway, authorization, audio and protocol    | 13 passed with local WebSocket transport                                                                                                  |
| Office browser workflows                            | 18 passed                                                                                                                                 |
| Discovery browser workflows                         | 11 passed, including save-outage recovery without another model call or document reload                                                   |
| TypeScript                                          | Passed                                                                                                                                    |
| Production Vite / Nitro and Lambda package          | Passed                                                                                                                                    |
| Changed TypeScript lint review                      | 141 files reviewed, no new semantic lint findings; existing-file formatting and prior warnings remain. Full repository lint is not clean. |
| Diff hygiene and credential scan                    | Whitespace check passed; 167 changed files scanned, only the explicitly fake voice test secret matched    |

The local Lambda validation package contains 850 files / 112,814,038 uncompressed bytes, with a ZIP size of 34,645,336 bytes and SHA-256 `9ad8832c4351a0f8f5965548e4f377eb3500fedf8d71fbd83f2912ce8a0309ba`. It contains intentionally invalid corpus build configuration and is not a deployable artifact. Existing large Office bundles still emit build size warnings; these checks do not establish improved runtime latency. One Discovery run emitted a React development warning about an update before mount; functional assertions passed, and authenticated staging should check this behavior as well.

```sh
bun install --frozen-lockfile --ignore-scripts
bun test src/lib
bun test tests/workflows-unit
bun test tests/office-server/interpreter-adapter.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false

# Optional isolated emulator, never a production dependency or live AWS endpoint.
npm install --prefix .integration.local/dynamo dynalite@4.0.0 --ignore-scripts --no-audit --no-fund
bun scripts/test-office-dynamo.mjs

# In services/office-voice: npm ci --ignore-scripts, then npm test.
node node_modules/vite/bin/vite.js build
node node_modules/@playwright/test/cli.js test --config playwright.office.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.discovery.config.ts
```

The emulator launcher binds an ephemeral loopback port, uses explicit dummy credentials and a unique temporary table, and cleans up after the run. It checks actual SDK serialization/expressions, owner/task/interpreter isolation, competing clients, expired claims, lost acknowledgments and recovery in a separate OS process. It does not establish live IAM permissions or AWS Lambda behavior.

Browser suites launch this checkout on port 5189 (override with `PLAYWRIGHT_PORT`) and refuse to reuse another development server. The test-only Vite launcher disables hot reload and ignores local result directories, so a dev-server reload cannot erase an in-progress simulated outage. Regular development keeps its existing hot reload behavior. The initial Discovery run exposed this reload race; it was reproduced with a Vite WebSocket diagnostic. The save-recovery assertions were retained, with an additional check that recovery never navigates away or reloads. Run the two suites sequentially. Do not run a Vite build against the same checkout while browser tests are using its server. Browser fixtures intercept authentication/services explicitly; they do not demonstrate real Cognito, S3, Bedrock or DynamoDB acceptance.

The Lambda package must also pass `scripts/build-lambda.mjs` / `scripts/package-lambda.mjs`. These require explicit build configuration. Local packaging validation may use a `.invalid` corpus origin and public fixture key; **that artifact must never be deployed**. Staging requires a fresh build with the approved testing configuration and its recorded commit/artifact hash.

## Required staging acceptance before merge / release

The intended testing AWS account is `475976462949`. At preparation time the relevant local CLI sessions were expired, so live acceptance is pending. Never fall back to another account or disable TLS verification to make a test pass. No cloud deployment or database mutation is part of the recorded local checks.

1. Confirm the intended profile/account and current deployed head. Use the branch's reviewed commit and real testing build configuration; record the resulting artifact digest and the previously working deployment for rollback.
2. Confirm deployed table, TTL and GetItem/UpdateItem access, exact AgentCore interpreter resource permissions, S3 ownership/CORS/checksum behavior and BDA access. The checked-in CORS change is only configuration text until deliberately applied.
3. In an authenticated testing session, upload a DOCX and an XLSX (include a 3.5–25 MB file). Verify complete extraction, late-document/page access, Unicode and ownership rejection from a second test user.
4. In one Office task, stage a file, run Python, then read/use that file in subsequent requests handled by **different Lambda instances** (record worker/log-stream identifiers). Confirm the same remote session ID and expected artifact tracking. Race two operations, interrupt one, test expiry, and verify no ambiguous code is replayed. Use synthetic non-client documents.
5. Verify a completed deposition survives a save outage, retries storage without a second model analysis, and reopens after reload. Exercise all three Discovery tabs with partial scans, citations, suggested columns, graph focus and exports.
6. In Writer, Sheets and Slides, verify real tool-assisted edits, exact-match failure behavior, Undo, source lookup, diagrams, long-file context, steering and Stop. Confirm current Research sources and citation workflows still operate with the new auth context.
7. Keep `OFFICE_VOICE_ENABLED` false/unset initially. Voice may be enabled deliberately in testing after the separate gateway is configured. Test authenticated low-latency speech, interruption, tool acknowledgment, document/mode changes, token expiry/renewal, disconnect and microphone cleanup before enabling elsewhere. The availability flag is a release gate, not automatic gateway health verification.
8. Review error/latency traces and outputs, resolve failures, attach evidence to the draft PR, and obtain final approval for merge/release. No automatic merge is configured by this work.

Rollback: use the previously verified application artifact/configuration. The new registry item prefix is additive and can remain until TTL cleanup; older code does not need it. Keep voice disabled. Do not delete existing user records, discard saved analyses or rewrite shared Git history as a rollback shortcut.

## Review and work ledger

- Prepared an isolated candidate from the current default-branch head, preserving the original working copy and upstream Research source support.
- Added durable Office coordination and the default-off voice gate.
- Independent read-only review found the Python terminal-status issue; corrected it and reproduced the fix through the actual adapter with a controlled SDK transport. No remaining actionable findings in that focused review.
- Real DynamoDB protocol testing found the reserved `snapshot` attribute; corrected it and passed the protocol tests, including separate-process recovery.
- Local checks and the focused independent review are complete. The branch is prepared for a draft PR; authenticated staging acceptance remains pending.

Related implementation context: [Discovery reliability](discovery-reliability-graph.md), [mapped insights](deposition-mapped-insights.md), [scan coverage](discovery-coverage-and-review.md), [Office document tools](office-agent-reliability.md), and [Office conversation/voice](office-conversation-and-voice.md). Earlier counts in those documents are historical; this handoff records the combined integration's results.
