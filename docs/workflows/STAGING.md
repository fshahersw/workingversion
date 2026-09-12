# Workflows staging and merge checklist

This branch integrates Workflows only. Do not merge the MCO repository or its application. Do not apply the platform foundation template to an existing production stack as part of this change.

## Before enabling

1. Review the final diff against `feat/frontier-ux`. Existing platform changes should be limited to Workflows navigation/routes, optional verified-email claim exposure, dependencies/build scripts and ignored Workflows build artifacts. No unrelated app routes, MCO code, user datasets, keys or uploaded files belong in the change.
2. Run the commands in [README.md](./README.md) from a clean install. Review [VALIDATION.md](./VALIDATION.md), including the limits of local tests. The original regression suite must remain passing.
3. Select a testing application, Cognito pool, data bucket/table with GSI1/GSI2, artifact bucket and execution roles. Confirm S3/KMS privacy, retention and backup settings. Avoid pointing a local shell at production data for a test.
4. Review IAM separately for the app and worker. Scope storage to the appropriate table and `workflows/*` S3 prefix. Give the worker only the model, knowledge retrieval and read-only research actions actually required. Validate Cognito account/group read access. Configure a dedicated network-disabled interpreter only if enabling Python.
5. Package the two workers; upload versioned ZIP keys to the environment's artifact bucket. Review an additive CloudFormation change set with `Enabled=false`. The existing application environment must receive Workflows variables through its normal deployment process.
6. Confirm model ID availability and capacity in this account/region. Supply worker tool configuration through approved environment/secret handling. A configured URL alone is not a successful connector test.
7. Connect operational alerting. The template creates a DLQ alarm without a notification target; add the environment's SNS/alarm routing. Monitor scheduler Lambda errors, queue age, failed runs, execution time and model spend. Daily admission/request limits are guardrails, not a dollar budget.

## Live staging checks (not performed by the integration author)

Use approved non-confidential test documents and at least three real test identities. Keep the fixture transport disabled—it exists only inside automated browser tests.

- Sign in; create/save/reload a definition; verify private ownership and behavior after logout/login. Navigate through the existing Research, Discovery and Office pages to confirm their native shell remains intact.
- With owner, team member and outsider accounts, exercise view/run/edit grants. Verify that run-only members see and execute the published form after the owner changes the draft. An outsider must not read a definition or run by guessing its UUID.
- Have two sessions edit one draft. The stale save must receive a conflict while preserving local edits/export. Publish a version, edit the draft, and verify the published run still uses the snapshot.
- Share a template and submit a document as one member. Another unassigned member must not read that run's input or result. A reviewer must have both verified email and workflow access. Test an unverified address and a different reviewer account; both must be rejected.
- Run a complete real PDF/DOCX through extraction and a Bedrock analysis. Include a late-page fact, negation, conflicting answers and an unreadable page. Check that warnings are visible, source anchors match and a truncated/invalid model response fails. Legal reviewers must assess semantic output quality independently.
- Generate CSV and DOCX, open the downloaded file, and save a report to the actual Word editor. Confirm source citations and table cells survive the Office import. Test PDF export with supported text; unsupported glyphs must produce an explicit Word-export instruction.
- Run configured web search, page fetch, DocketBird and private knowledge search individually. Verify no provider configuration or internal credentials appear in results. Confirm unavailable connectors fail rather than producing placeholder results.
- Kill an invocation after a completed step; redeliver SQS messages. Completed steps must stay immutable and unfinished steps recover after lease expiry. Cancel while a tool is working; a later checkpoint must not overwrite cancellation. Confirm lease conflicts do not produce duplicate committed outputs.
- Pause at human review, approve/reject from the assigned account, and verify the audit and source evidence are preserved downstream. Withdraw the group's run permission or disable the submitter between steps; further execution must stop.
- Schedule with real approved inputs, close the browser, and observe the timer running the published version. Test DST, waiting/resume, repeated delivery of one occurrence, one user's exhausted quota alongside another due schedule, and temporary queue interruption/outbox recovery.
- Run webpage monitoring twice with a known authorized content change. Confirm first-run baseline behavior and a later source comparison. Changing URL must not compare unrelated pages; another user's run must not supply the baseline.
- If Python is enabled, run two users concurrently and verify separate sessions. Check cancellation, runtime failure, cleanup and disabled network/privileged AWS access. Workflow input text must never be interpreted as arbitrary tool credentials or browser code.
- Inspect logs for source text or secrets. Assess 80-step and multi-document workloads, quota behavior, queue backlogs, large definitions and history limits. Agree on privacy/retention, alert ownership and acceptable model cost before broad rollout.

## Rollback

Set the app's `SW_WORKFLOWS_ENABLED=false` to block feature API operations, then set the Workflows stack `Enabled=false` to stop new worker consumption and timer dispatch. In-flight invocations can finish; cancel active runs before disabling if an immediate workflow stop is required. An operator can disable reserved concurrency for an emergency stop using the approved infrastructure process.

Keep S3 objects, DynamoDB rows, queue and DLQ intact while investigating. No table/schema migration is required to remove the app route. Revert this feature commit through normal forward Git history if necessary; do not force-push or rewrite the Lovable-connected branch. Stored data needs a separate authorized retention/deletion decision.

## Remaining integration work

Before claiming a full production rollout, record the live outcomes above, review IAM/change sets, establish notifications and retention, and obtain the production release owner's approval. Outlook/Box/OAuth webhooks, outbound email, nested subworkflows, arbitrary MCP registration and a legal citator/rules engine are separate implementations; this branch does not simulate them.
