# Workflows integration

This adds **only Workflows** to the Seeger Weiss AI platform. It does not integrate the MCO application, its records, dashboards, calendars, reconciliation, credentials, or data. The Workflows UI uses this repository's native `AppShell`, tokens, authentication and Office service.

**Deployment state:** disabled unless explicitly configured. A successful local build is not evidence that the production AWS account, model, IAM policies or tools have been validated. Complete [STAGING.md](./STAGING.md) before enabling a shared environment. See [AGENT_CONTEXT.md](./AGENT_CONTEXT.md) for future maintenance.

## What is implemented

| Capability        | Behavior                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workflows`      | Authenticated native page; library, builder, mini-app form and run history. `?workflow=<uuid>` opens a definition subject to access checks.                                                                                                                                         |
| Templates         | 56 reusable legal mini-app definitions across 15 firm roles, plus 6 foundational graph patterns. Nothing creates fake people, cases, documents or runs. Creating a template saves a private draft owned by the signed-in principal.                                                 |
| Builder           | Drag and connect steps, conditional branches, input forms, undo/redo, layout, import/export, explicit draft saves and immutable publication snapshots.                                                                                                                              |
| Persistence       | DynamoDB metadata and conditional transactions; private S3 payloads. Concurrent saves fail with a recoverable conflict instead of overwriting a newer draft. No browser database or local-storage workflow execution.                                                               |
| Runs              | SQS worker, one completed step per invocation, conditional leases, persisted checkpoints, cancellation and source snapshots. A due-work index provides an outbox for interrupted queue delivery.                                                                                    |
| Team access       | Owner controls sharing with their actual Cognito groups. Grants are view, run or edit. Run-only members use the published graph and form. Template sharing does not reveal every teammate's uploaded documents.                                                                     |
| Human review      | Pauses until the owner or exact assigned reviewer approves/rejects. Email-based reviewer access requires a verified Cognito email and access to the workflow. Decisions and notes are stored with the run.                                                                          |
| Document intake   | Actual TXT, Markdown, CSV/TSV, JSON, text PDF, DOCX and EML parsing; original-file hash for browser uploads; page/extraction warnings. Existing owned platform workspaces can supply their saved page text.                                                                         |
| Analysis          | Conservative deterministic source checks by default for the relevant recipes; explicit Bedrock analysis for semantic extraction, comparisons, drafting and configured AI recipes. Every supplied source chunk is visited; quote and line anchors are checked against supplied text. |
| Outputs           | Source/evidence table, CSV, real DOCX/PDF/text downloads and saving reports into the existing Word editor through `/api/office/docs`. Reports remain drafts for professional review.                                                                                                |
| Research          | Existing allowlisted read-only web, scientific/regulatory, DocketBird and citation-lookup tools. Scraping uses the host URL validation and bounded fetch service. Saved knowledge search is scoped to the submitter's own platform workspace.                                       |
| Monitoring        | Scheduled webpage capture and comparison. First run establishes a baseline. A subsequent run pins a prior completed snapshot from the same workflow, user and URL; unrelated users' results are excluded.                                                                           |
| Scheduling        | Daily/weekly schedules with an IANA timezone, published version and an explicit prior input run. Server timer continues with the browser closed. Each occurrence has a deterministic request ID. One failing schedule is backed off without blocking other entries.                 |
| Voice and folders | Native platform transcription through `MicButton`; user-selected local folder uploads and optional watching while the browser stays open. Read-aloud uses an installed local English voice.                                                                                         |
| Python            | Optional dedicated AgentCore interpreter. A fresh session per invocation receives `workflow_inputs.json`, returns bounded textual output, and is stopped in `finally`. No shared chat interpreter is reused.                                                                        |

## Boundaries and limitations

- This is an integration candidate. There is no live-service success claim or assertion of legal accuracy. Source anchoring detects unsupported quotations; it does not prove that a model's inference is legally correct or comprehensive.
- Outlook, Box and arbitrary MCP connections are **not implemented** by this branch. Unknown connectors fail visibly. Existing DocketBird services remain read-only. Notification steps create a message draft; they do not send email. Word report saving is implemented separately through the existing Office API.
- An AI-agent block is a configured model task in a graph, not an unrestricted autonomous tool loop. The per-file block collects file inputs; it does not spawn a nested workflow for each file. Add separately authorized adapters for those capabilities.
- No automatic legal deadline calculation, court-rule validation, citator treatment, complete Bluebook compliance or filing is asserted. The citation service checks existence and returns its limitations.
- Browser parsing does not add OCR. Scanned/partially unreadable PDFs need the platform's ingestion/OCR pipeline or a readable replacement. EML attachments must be supplied separately. DOCX uses extracted body text, not tracked-change or layout fidelity. Accepted extraction warnings must be acknowledged before execution.
- Scheduling reuses the selected run's immutable input snapshot and uses the latest published graph. It does not automatically fetch yesterday's mailbox or subscribe to Box events. Review inputs after publishing a new version.
- Monitoring compares the most recent matching successful snapshot among the last 30 runs **for that user and workflow**. It does not claim a change result when no baseline is found. It cannot access login-protected pages or execute page JavaScript.
- History lists the latest 30 accessible runs; definition discovery currently loads up to 100 links per owner/group partition, over the first 30 session groups. Pagination and large-firm load testing remain follow-up work.
- Row checkmarks in a report are view-local review aids; they are not the persisted workflow approval. Use the human-review step for an auditable decision.
- Archiving withdraws access and disables scheduling; it does not delete retained inputs. S3 snapshots, previous versions and abandoned conditional-write objects require an approved retention/lifecycle policy. No automatic purge is introduced.

## Configuration

Never put credentials in step configuration, workflow JSON, client bundles or checked-in environment files. Start with a separate testing stack using the platform's existing environment process.

| Setting                                    | Where                    | Meaning                                                                                                                                                   |
| ------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SW_WORKFLOWS_ENABLED=true`                | App, worker, scheduler   | Explicit feature switch; default off.                                                                                                                     |
| `SW_DDB_TABLE`, `SW_S3_BUCKET`             | All three                | Explicit existing storage for this environment; no development fallback accepted for enabling Workflows.                                                  |
| `SW_WORKFLOWS_QUEUE_URL`                   | All three                | Queue created by the additive Workflows stack.                                                                                                            |
| `SW_WORKFLOWS_SCHEDULER_ENABLED=true`      | App, scheduler           | Enables schedule configuration/dispatch. The scheduler also recovers queued runs and delays.                                                              |
| `COGNITO_USER_POOL_ID`                     | App and background roles | Same environment's pool. Workers revalidate enabled accounts and current groups between steps.                                                            |
| `COGNITO_REDIRECT_URI`                     | App                      | Canonical browser origin for mutation checks behind the existing proxy.                                                                                   |
| `BEDROCK_RESEARCH_MODEL`, `BEDROCK_REGION` | Worker                   | Explicit approved model/inference profile and region. Missing model fails the AI step.                                                                    |
| `SW_WORKFLOWS_DAILY_RUN_LIMIT`             | App and scheduler        | Optional per-submitter UTC daily admission cap, default 20 and maximum 200. Includes failed/admitted runs, not a billing ceiling. Keep values consistent. |
| `SW_WORKFLOWS_PYTHON_INTERPRETER_ID`       | Worker; app for display  | Optional dedicated interpreter ID. Leave unset to disable Python. Provision with network access disabled and least-privilege execution role.              |

The additive template is `infra/app/workflows.cfn.yaml`. It creates the SQS queue/DLQ, worker, scheduler, logs, timer and IAM delta. It uses existing, reviewed roles and storage; it does not recreate the foundation or update the application deployment's environment variables. Required base permissions include DynamoDB read/query/put/update/delete and transactional condition checks, S3 read/write on `workflows/*`, relevant KMS access, CloudWatch logs and the explicitly enabled provider actions. Cognito read permissions and queue permissions are supplied by this additive template. Verify `WorkerRoleArn` corresponds to `WorkerRoleName`.

Research tools need the **worker's** approved runtime configuration, not just the app's: see `src/lib/config.server.ts`, `src/lib/agents/agentcore-search.server.ts`, `brave-search.server.ts`, `tavily-search.server.ts` and `docketbird.server.ts`. The Workflows template deliberately contains no API key values. Supply any approved secrets using the deployment's existing secret mechanism. Knowledge search also requires the host knowledge-base configuration and scoped IAM permissions.

## Run and validate locally

```sh
bun install --frozen-lockfile
npm test
bun run test:workflows
node node_modules/typescript/bin/tsc --noEmit
bun run typecheck:workflows
bun run build
bun run build:workflows
bun run test:workflows:browser
```

Browser tests use installed Edge on Windows; elsewhere install Chromium with `bunx playwright install chromium`. They start Vite on port 5175. Their authentication/API fixtures are confined to the test runner, not production code. Real unauthenticated API rejection is checked without interception. Unit tests use AWS transport doubles and synthetic isolated input files; runtime templates contain no fixture data.

`build:workflows` produces `.artifacts/workflows/worker.zip` and `scheduler.zip`. Uploading these artifacts and applying infrastructure are separate operator actions. Build output is ignored by Git. No deployment command is run by this feature's scripts.

## Execution and data contract

- Definition metadata: `WF#DEF#<id>/META`. Owner/group links: `WFUSER#<sub>` and `WFGROUP#<group>`. Published snapshot pointers: `WFVERSION#<id>/VERSION#<version>`.
- Run metadata: `WF#RUN#<id>/META`; private discovery links under `WFRUNUSER`, `WFRUNREVIEW` and `WFRUNFLOW`. Large definitions and run snapshots live under `workflows/definitions/` and `workflows/runs/` in private S3.
- `GSI1` (`WF_RUN_DUE`, time + ID) is the due-work/outbox index. `GSI2` (`WF_SCHEDULE`, time + ID) indexes enabled schedules. Both existing indexes need ALL projections.
- API session ownership always comes from verified Cognito claims. Body-supplied owner, creator, publication or grant fields cannot confer access. POST requires same-origin JSON. Run source access is limited to the submitter, owner and explicit reviewers who still have definition access.
- Workers reload current account/group state, acquire a conditional lease and checkpoint each state transition. Completed steps are not replayed. An interrupted uncheckpointed read/model step can be retried and billed again; there is no exactly-once guarantee for model calls.
- Per-run bounds: 20 files; 20 MB original file; 300 PDF pages; 500,000 extracted characters per file; 1,000,000 aggregate source characters; 80 graph steps; 5.5 MB API request; 25 MB persisted payload. Large requests fail, never silently truncate.
- Model bounds: 12,000-character source chunks; 100 calls per step and 200 per run; 8,192 output tokens per call; full final-response completion required. Synthesis exceeding its context bound fails with a smaller-batch instruction. Quotation validation is mechanical, not a legal opinion.
- Worker lease 880 seconds, model-step abort 780 seconds, Lambda timeout 900 seconds, SQS visibility 5,400 seconds. Timer cadence is one minute; delays/schedules may run later under load. Delays support 1 second through 30 days with minute-level scheduler precision.

### API surface

All endpoints use `/api/workflows` and authenticated same-origin cookies.

| Request                                                             | Result                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------- | ----------------------------------- |
| `GET ?view=capabilities`                                            | Feature/configuration availability and signed-in groups; configuration is not a provider health check. |
| `GET`                                                               | Accessible definitions.                                                                                |
| `GET ?view=runs` / `?view=run&id=<uuid>`                            | Recent metadata / permission-checked full run. List responses omit source text and artifacts.          |
| `GET ?view=sources` / `?view=source&id=<itemId>`                    | Owned platform workspaces / complete saved page text subject to readiness and limits.                  |
| `POST {action:'save',id,revision,flow}`                             | Validated private create or optimistic draft update.                                                   |
| `POST {action:'publish'                                             | 'share'                                                                                                | 'schedule' | 'delete',id,revision,value?}` | Owner-only change. Delete archives. |
| `POST {action:'start',id,requestId,inputs,published}`               | Queued run; caller-generated UUID provides admission idempotency.                                      |
| `POST {action:'review',id,approved,notes}` / `{action:'cancel',id}` | Authenticated decision / cancellation.                                                                 |

There is no endpoint accepting arbitrary completed outputs or a browser-selected identity.
