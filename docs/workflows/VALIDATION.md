# Validation evidence

Validated locally on September 12, 2026, on branch `codex/workflows-production`, based on `feat/frontier-ux` at `b5dd53050fb8b8731b46bcd3ffebe06ac38a1cf5`. The remote base was checked again before delivery and had not moved.

## Passing checks

| Check                                       | Outcome                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline before integration                 | 383 existing tests, application TypeScript check and production build passed.                                                                                       |
| Existing regression suite after integration | `npm test`: 383 passed, 0 failed, 0 skipped.                                                                                                                        |
| Workflows tests                             | `bun test tests/workflows-unit`: 30 passed, 0 failed, 500 assertions.                                                                                               |
| Application types                           | `node node_modules/typescript/bin/tsc --noEmit`: passed.                                                                                                            |
| Workflows test/worker types                 | `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.workflows-tests.json`: passed. Bun's global test types are isolated from application compilation. |
| Production build                            | `node node_modules/vite/bin/vite.js build`: passed, including generated routes, SSR and Nitro output.                                                               |
| Worker artifacts                            | `node scripts/build-workflows.mjs`: both bundled Lambda handlers imported successfully in Node and were packaged into ZIPs; no invocation/deployment.               |
| Browser flows                               | Five passed on Edge at 1440×900, including a 390×844 responsive check.                                                                                              |
| Scoped ESLint                               | Zero errors; two development-only React Refresh warnings for utility exports in `ui.tsx`. No lint rules were weakened for production code.                          |
| Patch hygiene                               | `git diff --check`; runtime scan for demo records, browser workflow storage, sample datasets and inline key assignments.                                            |

## What the new checks establish

- All 56 legal mini-app definitions and six base patterns have valid graphs and no seeded runtime identities or source documents.
- Real server repository code rejects ownership spoofing, arbitrary group grants, stale saves, revoked access, unassigned review, private-source access and cancelled-run overwrite attempts.
- Publication preserves graph/form snapshots. Admission uses conditional writes for idempotency and quotas. Worker tests verify checkpoint continuation, active leases, account revocation and permission downgrade behavior.
- One schedule exceeding its quota does not block a different owner's due work; the failed occurrence retains its idempotency identity while backing off. Monitoring inputs retain a prior matching source snapshot and exclude unrelated URLs.
- Source bounds and extraction-warning acknowledgement are enforced. Additional pasted context is retained alongside file uploads. Missing branch inputs and unavailable AI services do not manufacture successful results.
- Grounded-analysis tests cover all source lines/chunks and rejection of invented quotations. DOCX archives are inspected for evidence content and source columns. Review decisions preserve evidence downstream.
- Browser checks exercise native navigation and an empty real-data library; create/edit/save/publish/share/run; unsaved-work recovery after a conflict; actual file parsing and a generated DOCX sent to the Office API contract; feature-disabled UI; and real unauthenticated API rejection.
- Visual inspection covered the builder and mini-app report on desktop and the responsive form on mobile. No MCO application pages or data are in the integration.

## Test boundaries

Repository tests use in-memory AWS **transport doubles** around real policy, transaction and worker code. Browser tests intercept authentication and workflow/Office transport inside Playwright; their text documents and identities are synthetic test fixtures. These are not runtime seed data, a production authentication bypass, real collaborators, a live Office save or an AWS deployment.

No Cognito test login, DynamoDB/S3 access, SQS delivery, EventBridge schedule, Bedrock invocation, DocketBird request, external app integration or Python execution was performed against the production account. Infrastructure was prepared and locally inspected; no AWS change set was created or applied. Provider permissions, network isolation, throughput, semantic/legal accuracy, retention and operational alerting remain staging/release checks in [STAGING.md](./STAGING.md).

Local build logs and screenshots remain in the ignored `.workflows.local/` directory. Generated worker artifacts remain in ignored `.artifacts/workflows/`. No credentials, uploaded documents, generated test artifacts or MCO code are included in Git.
