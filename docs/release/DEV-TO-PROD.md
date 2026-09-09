# Dev → staging → prod runbook

Every environment must be producible from this repo plus its parameters. Anything
done by hand in dev that is not on this list is a defect in the runbook.

## Accounts and profiles

| Environment | Account | SSO profile | Notes |
| --- | --- | --- | --- |
| testing | 475976462949 | `AdministratorAccess-475976462949` | Same data plane as local/dev. Hostname `https://testing.seegerweiss.com`. See below. Do not apply stacks until explicitly authorized. |
| dev | 475976462949 | `AdministratorAccess-475976462949` | DynamoDB `sw-dev-app`, Aurora cluster `sw-kb-kb`, Cognito pool `us-east-1_D7NX6OyAR` |
| staging | 475976462949 | `AdministratorAccess-475976462949` | Same account, separate stacks via `infra/app/parameters/staging-runtime.parameters.json` |
| prod | 247011205599 | `AdministratorAccess-sw-kb-prod` | Separate account. Never share tables, buckets or clusters with dev. |

`aws sso login --profile <profile>` before any step below.

## Release order

1. `npm test`, `npx tsc --noEmit`, `npm run build` are green on the release commit.
2. Foundation stack (`infra/app/app-foundation.cfn.yaml`): S3 bucket (CORS `AppOrigin`
   must match the environment's exact origin, or presigned PUTs fail silently and
   documents without a text layer cannot be saved), KMS, Cognito, DynamoDB.
3. KB ingest stack (`db/kb/infra/kb-ingest.cfn.yaml`).
4. **Database migrations, in order, every deploy:**
   `node --env-file=<env file> scripts/kb-apply-migration.mjs`
   (applies `db/kb/0001_kb_init.sql` then `db/kb/0002_kb_async_ingest.sql`; idempotent).
   Dev was missing `0002` for two days and every save failed with
   "Document indexing failed." This step is not optional and must run before the
   runtime stack takes traffic.
5. Runtime stack (`infra/app/app-runtime.cfn.yaml`) with the environment's parameter file.
6. Smoke test (below).

## Environment configuration that differs per environment

- `COGNITO_REDIRECT_URI`, `COGNITO_LOGOUT_URI`: exact origin, `https://` in staging/prod
  (this also turns on `Secure` cookies).
- `AppOrigin` (bucket CORS) = the app's exact origin.
- `KB_CLUSTER_ARN`, `KB_SECRET_ARN`, `KB_DATABASE`, `SW_DDB_TABLE`.
- Bedrock model access enabled in the account for every model the app calls:
  `amazon.titan-embed-text-v2:0`, `nvidia.nemotron-nano-3-30b`,
  `nvidia.nemotron-nano-12b-v2` (OCR and vision), `qwen.qwen3-vl-235b-a22b`,
  `google.gemma-3-27b-it`, `moonshotai.kimi-k2.5`, the Claude inference profile in
  `BEDROCK_WRITER_MODEL`, and the rerank model in `search.server.ts`.
- Aurora Serverless scale-to-zero: first call after idle can take ~15–30 s. The Data
  API client retries `DatabaseResumingException` (`sendWithRetry`). Keep min ACU > 0 in prod.

## Known Data API constraints (do not regress)

- The RDS Data API for Aurora PostgreSQL rejects array-typed parameters. Lists are
  passed as a comma-delimited string and split with `string_to_array` (`listParam` /
  `listCast` in `aurora.server.ts`; a test forbids `arrayValue`).
- Multi-statement SQL is rejected; the migration script splits statements.

## Smoke test (per environment, signed in as a real user)

1. Working Set: drop a PDF, Ask a question, Save workspace into a folder. Library shows
   it with a doc count > 0. Open from the Library rehydrates it.
2. Depositions: drop a transcript. Header shows "Saved" then "analysis <time>". Reload
   the page and reopen from the Library: transcripts and analysis return without re-running.
3. Tabular Review: create a table, Use working set (saved), add a column, Fill.
   Cell cites a page. Clear the Working Set session, reopen the table: the row rehydrates.
4. Library: create a folder, move an item, delete an empty folder, delete a workspace.
5. Leave the tab idle for over an hour, then act: no "Unauthorized"; the session
   refreshes silently. Check `/api/auth/me` returns the user.
6. Server logs contain no `[kb] workspace ingest failed` lines during the run.
7. Drafts: New document, type a line, header reaches "Saved". Assistant Write with a
   matter question streams tool rows, then a proposal card; Insert places numbered,
   linked references and a Sources list. Reopen from Library › Drafts: content and the
   assistant thread return. Export › Word downloads a .docx (uses the code interpreter).
   Import Word file opens a converted copy with the original kept on the draft.

## Verified on dev (2026-09-08)

- Migration `0002` applied to `sw-kb-kb`; Data API array-parameter fix deployed.
- Working Set save, Library reopen, Tabular Review bind + fill + rehydrate, Library
  delete, folder tree and folder picker, silent session refresh: verified in the browser.
- Not yet verified live: Deposition auto-save and analysis persistence (needs a
  transcript drop, which the browser automation cannot do) and the knowledge graph
  lenses on a real analysis.
- Drafts (2026-09-08): create, Write with research (8 sources, 20s), Insert with
  numbered references, autosave, two-tab conflict detection, Library listing and reopen
  with the assistant thread: verified in the browser. Not yet clicked live: Export and
  DOCX import (same docgen/mammoth paths the research agent and Working Set already use).

## Testing hostname (`testing.seegerweiss.com`)

Live in account `475976462949`. Reuses Cognito `us-east-1_D7NX6OyAR`, Dynamo
`sw-dev-app`, S3 `sw-dev-seegerweissai-475976462949`, and Aurora `sw-kb-kb`.
Do not apply `app-foundation.cfn.yaml`.

Stacks: `litai-testing-hosting`, `litai-testing-runtime`.
Temporary origin: `https://d1f0twgeed7iq3.cloudfront.net`.
Parameters: [`infra/app/parameters/testing-runtime.parameters.json`](../../infra/app/parameters/testing-runtime.parameters.json).

Deploy a new build from the repo root:

```
bun run deploy:testing
```

`--skip-build` reuses `infra/app/artifacts/app-runtime.zip`. `--flip-slot` when
REST API methods or integrations change. `--refresh-env` after rotating
`litai/testing/runtime`. `--attach-alias` only after ACM is ISSUED.

IT DNS, in order:

1. ACM validation CNAME `_3c236d26c4f0a003649a7d365efff816.testing.seegerweiss.com`
   → `_d975684775b6b3c6a5b56153e079c404.jkddzztszm.acm-validations.aws.`
2. App CNAME `testing.seegerweiss.com` → `d1f0twgeed7iq3.cloudfront.net`
3. `bun run deploy:testing -- --attach-alias`

Cognito callbacks and S3 CORS already include `https://testing.seegerweiss.com`.
Leftover: external corpus HTTP API and the local Vite package
`@lovable.dev/vite-tanstack-config`.
