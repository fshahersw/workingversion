# KB Operations Runbook

Provisioning, migration, configuration, cost, and troubleshooting for the KB.
See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works.

> **NO DEPLOY / NO MIGRATION FOR THE ASYNC-BDA PHASE:** Only local lint, tests,
> builds, packaging validation, `git diff --check`, and migration `--dry-run`
> are authorized. Do not invoke AWS, create a change set, upload an artifact,
> deploy either template, or apply `0002_kb_async_ingest.sql`.

All commands use the SSO profile `AdministratorAccess-475976462949` in `us-east-1`.
`aws sso login` and `aws iam` are operator-run.

## Deployed resources (stack `sw-kb`)

| Output                      | Value                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Cluster ARN                 | `arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb`                         |
| Endpoint (migration only)   | `sw-kb-kb.cluster-ckr6gqw4uh2z.us-east-1.rds.amazonaws.com`                   |
| kb_app secret ARN           | `arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh` |
| Master secret (RDS-managed) | name `rds!cluster-1f693eb0-dfc8-44c0-8286-d0ec02dfb516`                       |
| DB security group           | `sg-0952ff27e76e9c2ca`                                                        |
| App IAM policy              | `arn:aws:iam::475976462949:policy/sw-kb-kb-app-access`                        |
| Database                    | `kb`                                                                          |
| VPC / CIDR                  | `vpc-0e4fdf8f634d3c0b7` / `172.31.0.0/16`                                     |

IaC: [`db/kb/infra/kb-aurora.cfn.yaml`](../../db/kb/infra/kb-aurora.cfn.yaml).
Migrations, in order:
[`0001_kb_init.sql`](../../db/kb/0001_kb_init.sql), then
[`0002_kb_async_ingest.sql`](../../db/kb/0002_kb_async_ingest.sql).
Async IaC:
[`db/kb/infra/kb-ingest.cfn.yaml`](../../db/kb/infra/kb-ingest.cfn.yaml).

## Provisioning (from scratch)

```bash
aws cloudformation validate-template --template-body file://db/kb/infra/kb-aurora.cfn.yaml --profile AdministratorAccess-475976462949 --region us-east-1
```

```bash
aws cloudformation deploy --stack-name sw-kb --template-file db/kb/infra/kb-aurora.cfn.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides VpcId=<VPC_ID> "SubnetIds=<SUBNET_A>,<SUBNET_B>" MinCapacity=0 MaxCapacity=4 --profile AdministratorAccess-475976462949 --region us-east-1
```

```bash
aws cloudformation describe-stacks --stack-name sw-kb --query "Stacks[0].Outputs" --output table --profile AdministratorAccess-475976462949 --region us-east-1
```

Parameters: `MinCapacity=0` = scale-to-0 (dev; ~15s cold start on first call after
idle). Use `0.5` in prod to avoid the cold start. `EngineVersion` default `16.8`
(pgvector 0.8.x + HNSW). Deletion protection on; backups 7 days; storage encrypted.
The template preserves those deployed defaults and constrains backup retention,
capacity, and auto-pause inputs. Optional `AlarmTopicArn` routes CPU,
`DatabaseConnections`, and `ServerlessDatabaseCapacity` alarm and recovery
actions.

Local template validation does not call AWS:

```bash
cfn-lint db/kb/infra/kb-aurora.cfn.yaml
```

## Applying the migration (recommended — Data API, no VPC/psql)

`scripts/kb-apply-migration.mjs` discovers `db/kb/NNNN_*.sql`, sorts them by
name, and runs every migration over the Data API in order. `--file` limits an
operator-authorized run to one explicit file. It splits statements
(dollar-quote + comment aware), auto-resolves the
master secret, retries the cold start, sets the `kb_app` password, and smoke-tests.

```bash
AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 KB_CLUSTER_ARN=arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb KB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh node scripts/kb-apply-migration.mjs
```

`--dry-run` parses without any AWS calls. Idempotent (schema uses IF NOT EXISTS /
OR REPLACE). Fallback (psql from a VPC CloudShell / SSM bastion) is documented in
[`db/kb/README.md`](../../db/kb/README.md).

`KB_SECRET_ARN` is canonical for both the app and migration script.
`KB_APP_SECRET_ARN` remains a temporary migration-script fallback only.

For this async-BDA phase, run only:

```bash
node scripts/kb-apply-migration.mjs --dry-run
```

## App configuration (`.env`, operator-managed)

```
KB_CLUSTER_ARN=arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb
KB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh
KB_DATABASE=kb
KB_INGEST_JOBS_TABLE=<IngestJobsTableName output>
KB_INGEST_QUEUE_URL=<IngestQueueUrl output>
```

Without these, `kbConfigured()` is false and the KB routes/serverFns return `503`.
In `NODE_ENV=production`, `loadKbConfig()` instead fails closed when any of the
three values is missing. Configuration is loaded lazily so a stale import-time
environment snapshot is not retained.
The runtime role also consumes `AppIngestAccessPolicyArn` from the ingest stack.
Workers receive the app-table, app-bucket, Aurora, secret, BDA, and exact Titan
resource contracts through CloudFormation parameters. No static credentials are
accepted.

## Async BDA resources and local validation

`kb-ingest.cfn.yaml` defines:

- CMK-encrypted, PITR-enabled, deletion-protected job correlation table with TTL
  and `StatusUpdated`;
- CMK-encrypted completion queue and DLQ with TLS-only policies;
- exact direct-service event rules for BDA succeeded, client error, and service
  error events, each with bounded target retry and an EventBridge DLQ;
- a low-batch, bounded-concurrency Lambda event-source mapping with
  `ReportBatchItemFailures`;
- a five-minute stale-job reconciler that restarts stale queued reservations
  with the same token and polls stale converting/embedding invocations;
- retained encrypted log groups and DLQ-depth, queue-age, Lambda
  error/throttle, and EventBridge-failure alarms.

If `IngestKmsKeyArn` names an existing CMK, its key policy is a prerequisite
that this stack cannot add. Before deployment, the same-region symmetric key
must enable account IAM policies and explicitly allow:

- the regional CloudWatch Logs service principal for the two
  `/lit-ai/<prefix>/<environment>/kb-ingest*` encryption contexts;
- `events.amazonaws.com` to call `kms:Decrypt` and `kms:GenerateDataKey`, scoped
  by source account and the succeeded, failed, and reconciliation rule ARNs;
- the app runtime, worker, and reconciler permissions declared by their IAM
  policies for DynamoDB, SQS, and Lambda environment encryption.

The BDA rules and the reconciliation target all use the encrypted DLQ. A
missing EventBridge key-policy grant causes target delivery or DLQ delivery to
fail before a worker sees the event. Leave `IngestKmsKeyArn` empty unless the
external policy is already in place; the generated retained CMK includes these
service grants.

Local-only commands:

```bash
cfn-lint db/kb/infra/kb-aurora.cfn.yaml db/kb/infra/kb-ingest.cfn.yaml infra/app/app-foundation.cfn.yaml infra/app/app-runtime.cfn.yaml
node scripts/kb-apply-migration.mjs --dry-run
npm run validate:kb-ingest-workers
```

Worker bundling invokes Bun with `--no-env-file`, then imports both Node bundles
to catch unresolved aliases/entrypoints. Packaging is deterministic, includes
the root `type: module` manifest required for Node 22 Lambda handler loading,
verifies Unix `100644` entry modes, and writes only ignored local artifacts.
None of these commands call AWS.

## Cost

- Aurora Serverless v2 ~$0.12/ACU-hour (us-east-1). Scale-to-0 idles at ~$0 compute
  (pay S3 storage ~$0.023/GB-mo for objects, KMS, and Data API/Bedrock requests). A
  steady 0.5-ACU floor ≈ ~$43/month.
- Titan v2 embeddings and Bedrock rerank are billed per request/token. BDA,
  DynamoDB, SQS, EventBridge, Lambda, CloudWatch, and KMS add usage-based async
  ingest cost. No cost estimate in this phase authorizes deployment.

## Verifying end to end

1. In `/docs`, save a workspace, then open the **Library → Working Sets** tab and
   **Open** it — it should rehydrate.
2. Data API smoke (returns `count=0` even with rows, because RLS hides rows without
   `app.user`):
   ```bash
   aws rds-data execute-statement --resource-arn arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb --secret-arn arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh --database kb --sql "select count(*) from kb.documents" --profile AdministratorAccess-475976462949 --region us-east-1
   ```
   A clean result (no error) confirms role + grants + Data API.
3. From an authenticated browser session on `/docs`, list saved workspaces via the
   app (Library) rather than the CLI (RLS).

## Troubleshooting

| Symptom                                          | Cause                                          | Fix                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| First save/search after idle fails or hangs ~15s | scale-to-0 cold start                          | expected; `sendWithRetry` waits it out — retry if it surfaced before the fix                                                  |
| Routes return `503 KB is not configured`         | `KB_*` env unset                               | set the three vars in `.env`, restart dev                                                                                     |
| Routes return `401`                              | no Cognito session                             | sign in; routes are gated by `apiAuthMiddleware`                                                                              |
| CLI `count` shows 0 but you saved docs           | FORCE RLS hides rows without `app.user`        | verify via app routes/serverFns, not raw CLI                                                                                  |
| Save shows "Save failed"                         | ingest/embed/Aurora error                      | check the error text (hover); confirm env + SSO not expired                                                                   |
| Workspace remains queued/converting              | BDA event was missed or worker delayed         | scheduled reconciliation should enqueue the same compact event; inspect queue-age/DLQ alarms without exposing payload content |
| Async upload enters terminal error before BDA    | signed checksum or object size does not match  | re-upload the original file; do not bypass the checksum/HEAD integrity gate                                                   |
| Async route returns unavailable                  | dedicated table/queue env is absent            | supply reviewed ingest-stack outputs to the runtime stack                                                                     |
| Pending workspace deletion is incomplete         | a correlation/Aurora/S3/checkpoint stage failed | retry the same delete; metadata is retained until all stages finish                                                           |
| `psql` can't reach the cluster                   | cluster is private                             | use the Data API apply script, or a VPC CloudShell/SSM bastion                                                                |

## Security notes

- No static AWS keys anywhere in the KB path (SigV4 default chain).
- FORCE RLS + transaction-local `app.user` GUC isolate every row to the Cognito
  principal; per-workspace `kbWorkspaceId` partitions within a user.
- S3 objects are SSE-KMS and namespaced by `sub`; ownership re-checked on read.
- Async upload URLs bind SHA-256 in the signed PUT. A metadata-only `HeadObject`
  must match both checksum and byte size before BDA starts; object bodies are
  never read for this check.
- Do not enable public accessibility on the cluster (Security Hub RDS.2); apply
  migrations privately (Data API or VPC CloudShell/SSM).
- No PHI in logs; converter/model error detail is capped/scrubbed.
- Job rows intentionally contain the exact owner principal plus correlation,
  request/source hashes, and owned coordinates, but no page/document text or
  file name. Queue/DLQ events contain only version, invocation ARN, outcome,
  and correlation id.
- Never troubleshoot tenant ownership by querying Aurora with an invocation ARN.
  Resolve the exact dedicated job mapping, then use `withPrincipal(ownerSub)`.
- Deleting a pending workspace removes its correlation record before Aurora/S3
  cleanup. BDA cancellation is not relied upon; an already-running invocation
  may finish after deletion, so lifecycle/orphan cleanup of its owned output
  prefix remains an operational backstop.
