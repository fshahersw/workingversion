# KB database (Aurora PostgreSQL + pgvector)

The per-user document knowledge base for the Discovery **Working Set** tab. This is
a **net-new, AWS-native** store — the first app-owned relational/vector database.
It is entirely separate from the legacy Supabase primary and corpus projects (which
are being retired) and is reached **directly by the app via the RDS Data API**, not
PostgREST. Design: [`docs/kb-ingest-design.md`](../../docs/kb-ingest-design.md).

## What lives here

- `kb.documents` — one row per uploaded file (metadata + status). Page text /
  BDA markdown blobs live in S3 (`s3_key`), not in Postgres.
- `kb.chunks` — page-anchored, table-aware chunks with `content` (verbatim),
  `context` (contextual-retrieval prefix, embed-only), a generated `tsv` (BM25 leg),
  and a `vector(1024)` Titan v2 embedding (HNSW cosine).
- `kb.hybrid_search(...)` — RRF fuse of vector kNN + BM25 in one round trip,
  scoped to `(owner_sub, workspace_id, surface)` with an optional doc-id restrict.

## Provisioning (out of band, one time)

Not covered by this SQL (no IaC in the repo yet):

1. Aurora PostgreSQL **Serverless v2** cluster in `us-east-1`, KMS-encrypted, in a
   private subnet. Enable the **RDS Data API** and **IAM DB authentication**.
2. Create a database (e.g. `kb`).
3. A Secrets Manager secret with credentials for the **`kb_app`** role (NOT the
   master user) — FORCE RLS only constrains non-owner roles, and `kb_app` is the
   least-privilege app role this migration grants to.
4. Confirm the Aurora engine version ships `pgvector` (>= the version that provides
   HNSW).

## Applying the migration

Either via `psql` against the cluster endpoint, or the Data API. Example:

```bash
psql "$KB_ADMIN_URL" -f db/kb/0001_kb_init.sql
```

Idempotent — safe to re-run. Run as an admin/owner role (it creates the schema,
`kb_app` role, tables, function, and policies).

## App connection + tenancy (RDS Data API)

The server seam (`src/lib/kb/aurora.server.ts`, P1 follow-up) uses
`@aws-sdk/client-rds-data` with the default AWS credential chain (SigV4 — no static
keys), reading:

- `KB_CLUSTER_ARN` — Aurora cluster ARN
- `KB_SECRET_ARN` — Secrets Manager ARN for the `kb_app` credentials
- `KB_DATABASE` — database name (e.g. `kb`)

**Per-request tenant isolation.** Every data call runs inside a Data API transaction
that first sets the principal, so FORCE RLS scopes the connection:

```
BeginTransaction
  SET LOCAL app.user = '<verified Cognito sub>'   -- from getUserFromRequest, never client input
  <statements>
CommitTransaction
```

`current_setting('app.user', true)` returns NULL when unset, so an unscoped
connection is default-deny (sees no rows). Queries also pass `owner`/`workspace`
explicitly to `kb.hybrid_search` as belt-and-suspenders.

## Dimensions / models

- Embeddings: `amazon.titan-embed-text-v2:0`, **1024-dim**, normalized, cosine.
- Rerank (post-retrieval, app side): `cohere.rerank-v3-5:0` via the Bedrock Rerank
  API — pre-truncate the fused pool to ~150 before rerank.

## Migration order

- `0001_kb_init.sql` — schema, indexes, hybrid function, `kb_app` role, FORCE RLS.
- Future: `0002_*` shared-workspace membership (extends the RLS USING clause).
