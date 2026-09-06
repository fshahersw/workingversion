# KB Operations Runbook

Provisioning, migration, configuration, cost, and troubleshooting for the KB.
See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works.

All commands use the SSO profile `AdministratorAccess-475976462949` in `us-east-1`.
`aws sso login` and `aws iam` are operator-run.

## Deployed resources (stack `sw-kb`)

| Output | Value |
|---|---|
| Cluster ARN | `arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb` |
| Endpoint (migration only) | `sw-kb-kb.cluster-ckr6gqw4uh2z.us-east-1.rds.amazonaws.com` |
| kb_app secret ARN | `arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh` |
| Master secret (RDS-managed) | name `rds!cluster-1f693eb0-dfc8-44c0-8286-d0ec02dfb516` |
| DB security group | `sg-0952ff27e76e9c2ca` |
| App IAM policy | `arn:aws:iam::475976462949:policy/sw-kb-kb-app-access` |
| Database | `kb` |
| VPC / CIDR | `vpc-0e4fdf8f634d3c0b7` / `172.31.0.0/16` |

IaC: [`db/kb/infra/kb-aurora.cfn.yaml`](../../db/kb/infra/kb-aurora.cfn.yaml).
Migration: [`db/kb/0001_kb_init.sql`](../../db/kb/0001_kb_init.sql).

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

## Applying the migration (recommended — Data API, no VPC/psql)

`scripts/kb-apply-migration.mjs` runs the SQL over the Data API from anywhere with
AWS creds. It splits statements (dollar-quote + comment aware), auto-resolves the
master secret, retries the cold start, sets the `kb_app` password, and smoke-tests.

```bash
AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 KB_CLUSTER_ARN=arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb KB_APP_SECRET_ARN=arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh node scripts/kb-apply-migration.mjs
```
`--dry-run` parses without any AWS calls. Idempotent (schema uses IF NOT EXISTS /
OR REPLACE). Fallback (psql from a VPC CloudShell / SSM bastion) is documented in
[`db/kb/README.md`](../../db/kb/README.md).

## App configuration (`.env`, operator-managed)

```
KB_CLUSTER_ARN=arn:aws:rds:us-east-1:475976462949:cluster:sw-kb-kb
KB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:475976462949:secret:sw-kb/kb/kb_app-voZDNh
KB_DATABASE=kb
```
Without these, `kbConfigured()` is false and the KB routes/serverFns return `503`.
The app runtime role needs the `sw-kb-kb-app-access` policy (dev SSO admin already
covers it).

## Cost

- Aurora Serverless v2 ~$0.12/ACU-hour (us-east-1). Scale-to-0 idles at ~$0 compute
  (pay S3 storage ~$0.023/GB-mo for objects, KMS, and Data API/Bedrock requests). A
  steady 0.5-ACU floor ≈ ~$43/month.
- Titan v2 embeddings and Bedrock rerank billed per request/token (small at this
  scale). BDA (when the async lane lands) ~$0.01/page.

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

| Symptom | Cause | Fix |
|---|---|---|
| First save/search after idle fails or hangs ~15s | scale-to-0 cold start | expected; `sendWithRetry` waits it out — retry if it surfaced before the fix |
| Routes return `503 KB is not configured` | `KB_*` env unset | set the three vars in `.env`, restart dev |
| Routes return `401` | no Cognito session | sign in; routes are gated by `apiAuthMiddleware` |
| CLI `count` shows 0 but you saved docs | FORCE RLS hides rows without `app.user` | verify via app routes/serverFns, not raw CLI |
| Save shows "Save failed" | ingest/embed/Aurora error | check the error text (hover); confirm env + SSO not expired |
| `psql` can't reach the cluster | cluster is private | use the Data API apply script, or a VPC CloudShell/SSM bastion |

## Security notes

- No static AWS keys anywhere in the KB path (SigV4 default chain).
- FORCE RLS + transaction-local `app.user` GUC isolate every row to the Cognito
  principal; per-workspace `kbWorkspaceId` partitions within a user.
- S3 objects are SSE-KMS and namespaced by `sub`; ownership re-checked on read.
- Do not enable public accessibility on the cluster (Security Hub RDS.2); apply
  migrations privately (Data API or VPC CloudShell/SSM).
- No PHI in logs; converter/model error detail is capped/scrubbed.
