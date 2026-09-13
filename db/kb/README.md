# KB database (Aurora PostgreSQL + pgvector)

The per-user document knowledge base for the Discovery **Working Set** tab. This is
a **net-new, AWS-native** store — the first app-owned relational/vector database.
It is entirely separate from the legacy Supabase primary and corpus projects (which
are being retired) and is reached **directly by the app via the RDS Data API**, not
PostgREST. Design: [`docs/kb-ingest-design.md`](../../docs/kb-ingest-design.md).

> **NO DEPLOY / NO MIGRATION FOR ASYNC-BDA:** Validate locally only. Do not
> invoke AWS, create a change set, upload worker artifacts, deploy
> `db/kb/infra/kb-ingest.cfn.yaml`, or apply `0002_kb_async_ingest.sql`.

## What lives here

- `kb.documents` — one row per uploaded file (metadata + status). Page text /
  BDA markdown blobs live in S3 (`s3_key`), not in Postgres.
- `kb.chunks` — page-anchored, table-aware chunks with `content` (verbatim),
  `context` (contextual-retrieval prefix, embed-only), a generated `tsv` (BM25 leg),
  and a `vector(1024)` Titan v2 embedding (HNSW cosine).
- `kb.hybrid_search(...)` — RRF fuse of vector kNN + BM25 in one round trip,
  scoped to `(owner_sub, workspace_id, surface)`, returns **bounded snippets**
  (Data API 1 MiB / 64 KB caps — see below), with an optional doc-id restrict.
- `kb.fetch_chunks(...)` — full chunk bodies for the reranked top-K (bounded id
  list) at synthesis time.
- `0002_kb_async_ingest.sql` adds owner-scoped BDA input/output/invocation
  metadata, client file correlation, timestamps, constrained ingest statuses,
  owner-prefix checks, and supporting indexes.
  FORCE RLS and `kb_app` grants are reasserted.

## Provisioning — CloudFormation (prod-quality, private)

Aurora IaC lives at [`infra/kb-aurora.cfn.yaml`](infra/kb-aurora.cfn.yaml): Aurora
PostgreSQL Serverless v2, **private** (no public access), **RDS-managed master
password**, Data API enabled, deletion protection, backups, optional scale-to-0,
a generated `kb_app` secret, and a least-privilege app access policy.

Async ingest IaC lives at
[`infra/kb-ingest.cfn.yaml`](infra/kb-ingest.cfn.yaml). It defines a dedicated
CMK-encrypted job table with `StatusUpdated`, encrypted SQS/DLQ, exact BDA
EventBridge rules with bounded target retry/DLQ, bounded worker/reconciler
Lambdas, retained encrypted logs, least-privilege policies, and
error/throttle/age/delivery alarms. It consumes producer outputs and does not
adopt existing resources.
When supplying an external `IngestKmsKeyArn`, preconfigure its key policy for
the regional Logs principal and the three exact EventBridge rule ARNs, and
enable account IAM policies for the app/worker/reconciler roles. The template
cannot modify an external key; see `docs/kb/OPERATIONS.md`.

Validate, then deploy (needs two subnets in different AZs; `MinCapacity=0` for a
dev cluster that auto-pauses, or `0.5` in prod to avoid the ~15s resume):

```bash
aws cloudformation validate-template --template-body file://db/kb/infra/kb-aurora.cfn.yaml --profile AdministratorAccess-475976462949 --region us-east-1
```

```bash
aws cloudformation deploy --stack-name sw-kb --template-file db/kb/infra/kb-aurora.cfn.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides VpcId=<VPC_ID> SubnetIds=<SUBNET_A>,<SUBNET_B> MinCapacity=0 MaxCapacity=4 --profile AdministratorAccess-475976462949 --region us-east-1
```

```bash
aws cloudformation describe-stacks --stack-name sw-kb --query "Stacks[0].Outputs" --output table --profile AdministratorAccess-475976462949 --region us-east-1
```

Note the outputs: `ClusterArn`, `ClusterEndpoint`, `KbAppSecretArn`,
`MasterSecretArn`, `DbSecurityGroupId`, `AppAccessPolicyArn`.

## Applying the migration (private — no public access)

**Recommended — apply over the Data API (no VPC / psql / CloudShell).**
`scripts/kb-apply-migration.mjs` applies the reviewed fixed sequence
`0001_kb_init.sql`, `0002_kb_async_ingest.sql`, then `0003_reference_courts.sql`, and splits each file into single statements
(dollar-quote + comment aware; the Data API forbids multi-statement calls) and runs
each with the RDS-managed master secret, then sets the `kb_app` password from its
secret and runs a smoke query. Runs from anywhere with your AWS creds:

```bash
AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 KB_CLUSTER_ARN=<ClusterArn> KB_SECRET_ARN=<KbAppSecretArn> node scripts/kb-apply-migration.mjs
```

It auto-resolves the master secret from the cluster. `--dry-run` parses without any
AWS calls. Idempotent (the schema uses IF NOT EXISTS / OR REPLACE and guarded
constraints).
`KB_APP_SECRET_ARN` is accepted only as a temporary compatibility fallback;
`KB_SECRET_ARN` is canonical for both migration and application runtime.

**Fallback — psql from inside the VPC.** The cluster has no standing 5432 ingress,
so use a VPC-connected **AWS CloudShell** (or an SSM bastion) with `psql`. Do NOT use
the RDS Query Editor (its Data-API multi-statement limit breaks the PL/pgSQL bodies)
and do NOT enable public accessibility (Security Hub RDS.2).

1. In a VPC CloudShell environment (same VPC, a private subnet), add a temporary
   ingress rule so CloudShell's ENI can reach 5432:
   ```bash
   aws ec2 authorize-security-group-ingress --group-id <DbSecurityGroupId> --protocol tcp --port 5432 --source-group <CLOUDSHELL_OR_BASTION_SG> --profile AdministratorAccess-475976462949 --region us-east-1
   ```
2. Read the **master** credentials (RDS-managed) from Secrets Manager:
   ```bash
   aws secretsmanager get-secret-value --secret-id <MasterSecretArn> --query SecretString --output text --profile AdministratorAccess-475976462949 --region us-east-1
   ```
3. Apply the schema into `kb` (the CFN already created the `kb` database):
   ```bash
   psql "host=<ClusterEndpoint> port=5432 dbname=kb user=kbmaster password=<MASTER_PW> sslmode=require" -f db/kb/0001_kb_init.sql
   psql "host=<ClusterEndpoint> port=5432 dbname=kb user=kbmaster password=<MASTER_PW> sslmode=require" -f db/kb/0002_kb_async_ingest.sql
   psql "host=<ClusterEndpoint> port=5432 dbname=kb user=kbmaster password=<MASTER_PW> sslmode=require" -f db/kb/0003_reference_courts.sql
   ```
4. Set the `kb_app` role's password to the generated secret value so the Data API
   can authenticate as it (read `<KbAppSecretArn>` for `<KBAPP_PW>`):
   ```bash
   psql "host=<ClusterEndpoint> port=5432 dbname=kb user=kbmaster password=<MASTER_PW> sslmode=require" -c "ALTER ROLE kb_app WITH LOGIN PASSWORD '<KBAPP_PW>';"
   ```
5. Remove the temporary ingress rule (leave the SG with no standing ingress):
   ```bash
   aws ec2 revoke-security-group-ingress --group-id <DbSecurityGroupId> --protocol tcp --port 5432 --source-group <CLOUDSHELL_OR_BASTION_SG> --profile AdministratorAccess-475976462949 --region us-east-1
   ```

Migration is idempotent — safe to re-run.

## Wiring the app

1. Attach Aurora `<AppAccessPolicyArn>` plus async-ingest
   `<AppIngestAccessPolicyArn>` to the app runtime role.
2. Set env (your `.env` — not touched by this repo):
   ```
   KB_CLUSTER_ARN=<ClusterArn>
   KB_SECRET_ARN=<KbAppSecretArn>
   KB_DATABASE=kb
   KB_INGEST_JOBS_TABLE=<IngestJobsTableName>
   KB_INGEST_QUEUE_URL=<IngestQueueUrl>
   ```
   Async clients use checksum-bound presigned PUTs. The app and reconciler
   verify the S3 checksum and byte size with `HeadObject` before starting BDA.
3. Smoke-test the Data API path end to end (a `0` count = role/grants/Data API OK):
   ```bash
   aws rds-data execute-statement --resource-arn <ClusterArn> --secret-arn <KbAppSecretArn> --database kb --sql "select count(*) from kb.documents" --profile AdministratorAccess-475976462949 --region us-east-1
   ```

## App connection + tenancy (RDS Data API)

The seam `src/lib/kb/aurora.server.ts` uses `@aws-sdk/client-rds-data` with the
default AWS credential chain (SigV4, no static keys). Every data call runs inside a
Data API transaction that first sets the principal, so FORCE RLS scopes it:

```
BeginTransaction
  SELECT set_config('app.user', '<verified Cognito sub>', true)   -- its own call; transaction-local
  <statements>
CommitTransaction
```

A Data API transaction is a single serialized backend session, so the
transaction-local GUC holds for the transaction. `current_setting('app.user', true)`
is NULL when unset → default-deny. Queries also pass `owner`/`workspace` explicitly
to the functions (belt and suspenders).

## Data API limits this schema is designed around

- **1 MiB per result set, 64 KB per row — HARD errors, not truncation.**
  `hybrid_search` returns `left(content, p_snippet_chars)` (default 2500) and a
  modest default `p_match` (120); it NEVER selects the embedding column (a 1024-dim
  vector as text is ~10-15 KB/row and would blow the cap). Full bodies come from
  `fetch_chunks` for a bounded top-K.
- Chunk `content` is capped < 64 KB at ingest (the ~512-token target does this).
- Scale-to-0 (dev): the first Data API call after idle pays a ~15s resume.

## Dimensions / models

- Embeddings: `amazon.titan-embed-text-v2:0`, **1024-dim**, normalized, cosine.
- Rerank (post-retrieval, app side): `cohere.rerank-v3-5:0` via the Bedrock Rerank
  API — pre-truncate the fused pool before rerank.

## Migration order

- `0001_kb_init.sql` — schema, indexes, `hybrid_search` + `fetch_chunks`, `kb_app`
  role, FORCE RLS.
- `0002_kb_async_ingest.sql` — additive async BDA metadata, status constraints,
  owned-prefix and client-correlation constraints, indexes, and
  FORCE-RLS/grant reassertion.
- `0003_reference_courts.sql` — firm-global court reference library
  (`reference.courts` / `judges` / `court_documents`), no RLS, `kb_app` SELECT
  only, plus the `corpus.dockets.assigned_judge` / `referred_judge` columns the
  matters court layer reads.

For this phase, only parse the ordered sequence:

```bash
node scripts/kb-apply-migration.mjs --dry-run
```
