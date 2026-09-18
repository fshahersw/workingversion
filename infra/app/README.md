# Production application infrastructure

> Testing updates use `bun run deploy:testing` from the repo root. That command
> rebuilds the Lambda zip, uploads a versioned object, and updates
> `litai-testing-runtime` only. Do not apply `app-foundation.cfn.yaml` in
> account `475976462949`; it would create a second Cognito pool, Dynamo table,
> and S3 bucket. Staging and prod remain gated.

These templates describe new greenfield environments. Provision and verify
`staging` before preparing `prod`. They do not import, discover, reference by
physical name, or adopt the existing development resources.

## Templates

### `app-foundation.cfn.yaml`

The foundation owns retained state and producer-managed runtime permissions:

- Customer-managed KMS key with rotation and retained replacement/deletion
  behavior.
- On-demand DynamoDB table with point-in-time recovery, deletion protection,
  TTL, two GSIs, and KMS encryption.
- Private, versioned application-data bucket with Block Public Access,
  bucket-owner enforced ownership, TLS-only access, KMS encryption, and
  lifecycle controls.
- Private, versioned deployment-artifact bucket with the same public-access,
  TLS, and KMS controls. Current artifact versions do not expire; superseded
  versions use the dedicated retention parameter.
- Cognito user pool, public PKCE web client, managed domain, and optional
  `admin` group.
- A generated, retained Secrets Manager value used only to authenticate
  CloudFront to the REST API origin. Only its ARN is output.
- App-owned IAM permissions for DynamoDB, S3, exact Bedrock model/rerank
  resources, exact BDA project/profile resources, account-scoped BDA invocation
  jobs, and exact AgentCore gateway/Code Interpreter resources.
- Retained KMS-encrypted application log group and baseline data alarms.

The legacy optional RDS and database-secret parameters remain for compatibility
with non-KB integrations. Leave them empty for the KB. The separately deployed
KB stack owns and outputs its own managed policy.

### `app-runtime.cfn.yaml`

The runtime consumes foundation and KB outputs as parameters and creates:

- A managed Node.js Lambda function running `.output/server/index.mjs` through
  the pinned official Lambda Web Adapter v28 layer selected by architecture.
- `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`,
  `AWS_LWA_INVOKE_MODE=response_stream`, and port `8080` for both Nitro and the
  adapter.
- A Regional API Gateway **REST API** with root and `{proxy+}` `ANY` methods.
  Both integrations use `AWS_PROXY`, `ResponseTransferMode: STREAM`, and a URI
  ending in `/response-streaming-invocations`.
- All SSE routes emit a comment heartbeat every 25 seconds, below the
  CloudFront origin idle timeout, including during long retrieval/model gaps.
- Minimal API access logs, metrics, X-Ray, stage and usage-plan throttles, and a
  scoped API Gateway invocation role.
- A generated origin API key resolved from the foundation secret. CloudFront
  injects it as `x-api-key`; direct execute-api calls without it are rejected.
- CloudFront with no caching for the default app/auth/API behavior. The managed
  all-viewer-except-Host request policy forwards cookies, query strings,
  authorization, and SSE request headers. Only `/assets/*` uses the managed
  optimized cache policy.
- A CloudFront-scoped WAF web ACL with AWS managed common and known-bad-input
  rules plus a configurable per-IP rate rule. The common group's
  `SizeRestrictions_BODY` rule is count-only because the current authenticated
  KB ingest route accepts bounded document text; API Gateway and application
  size limits remain enforced. Both managed groups carry a scope-down that
  skips authenticated Office/Writer binary uploads (`/api/*` requests whose
  `Content-Type` is an OOXML document, PDF or octet-stream): those bodies are
  compressed archives whose bytes trip the body-inspecting rules at random
  (`CrossSiteScripting_BODY` blocked every Writer recovery snapshot and
  intermittent saves). The app requires a Cognito session on every non-public
  `/api/` route and size-caps and archive-validates those bodies; all JSON
  APIs and every unauthenticated path remain fully inspected.
- Retained KMS-encrypted Lambda and API access log groups. Staging retains logs
  for 30 days and prod for 365 days.
- Lambda error, throttle, and duration alarms plus API 5xx and latency alarms.

`ApiDeploymentSlot` must alternate between `blue` and `green` whenever a REST
resource, method, integration, timeout, or response-streaming setting changes.
API Gateway deployments are immutable snapshots; changing a method without
changing the slot can leave the stage on the previous API model.

The runtime stack intentionally does not create `AWS::ApiGateway::Account`.
That setting is regional and changing it could affect unrelated or existing
APIs. Before a later authorized deployment, confirm that the separately managed
regional API Gateway CloudWatch role can deliver REST API access logs.

The CloudFront-scoped WAF must be created in `us-east-1`; the template includes
a rule that rejects another region.

## Cross-stack configuration contract

Pass exact stack outputs, not reconstructed physical names.

Foundation output to runtime parameter and environment:

- `DeploymentArtifactBucketName` -> `ArtifactBucketName`
- `KmsKeyArn` -> `AppKmsKeyArn`
- `ApplicationAccessPolicyArn` -> `AppAccessPolicyArn`
- `DynamoTableName` -> `DynamoTableName` -> `SW_DDB_TABLE`
- `S3BucketName` -> `AppDataBucketName` -> `SW_S3_BUCKET`
- `CloudFrontOriginAccessSecretArn` -> `OriginAccessSecretArn`
- `CognitoRegion` -> `CognitoRegion` -> `COGNITO_REGION`
- `CognitoUserPoolId` -> `CognitoUserPoolId` -> `COGNITO_USER_POOL_ID`
- `CognitoClientId` -> `CognitoClientId` -> `COGNITO_CLIENT_ID`
- `CognitoDomain` -> `CognitoDomain` -> `COGNITO_DOMAIN`
- `CognitoCallbackUrl` -> `CognitoRedirectUri` -> `COGNITO_REDIRECT_URI`
- `CognitoLogoutUrl` -> `CognitoLogoutUri` -> `COGNITO_LOGOUT_URI`

KB output to runtime parameter and environment:

- `AppAccessPolicyArn` -> `KbAccessPolicyArn`
- `ClusterArn` -> `KbClusterArn` -> `KB_CLUSTER_ARN`
- `KbAppSecretArn` -> `KbSecretArn` -> `KB_SECRET_ARN`
- `Database` -> `KbDatabase` -> `KB_DATABASE`

The runtime role attaches both producer policies. It does not copy the KB
policy document. `KbSecretArn` is an ARN consumed by the RDS Data API SDK; the
secret value is not placed in the Lambda environment. The legacy corpus
service credential is supplied only as `CorpusServiceSecretArn`; CloudFormation
resolves its `CORPUS_SERVICE_KEY` JSON field into the KMS-encrypted Lambda
environment without accepting the value as a stack parameter.

## Reproducible Lambda package

The package contains these paths at its root:

- `server/**` from `.output/server`
- `public/**` from `.output/public`
- `build-metadata.json` with the intended staging/prod environment and public
  corpus origin
- `run.sh`

`vite.config.ts` pins Nitro to `node-server`; the Lovable wrapper's default
`cloudflare-module` output does not start a Node listener and is not valid for
Lambda Web Adapter. The Node packager verifies that preset, sorts entries,
fixes ZIP timestamps, sets ordinary files to Unix `0644`, sets `run.sh` to Unix
`0755`, and rejects CRLF in `run.sh`. The source file is also pinned to LF in
`.gitattributes`.

From the repository root:

```powershell
$env:LITAI_BUILD_ENVIRONMENT = "staging"
$env:VITE_CORPUS_URL = "https://replace-with-staging-corpus.example"
$env:VITE_CORPUS_KEY = "replace-with-public-publishable-key"
node scripts/build-lambda.mjs
bun run package:lambda
```

Or build and package together:

```powershell
$env:LITAI_BUILD_ENVIRONMENT = "staging"
$env:VITE_CORPUS_URL = "https://replace-with-staging-corpus.example"
$env:VITE_CORPUS_KEY = "replace-with-public-publishable-key"
bun run build:lambda
```

Only `build:lambda` is valid for a deployment artifact. It requires explicit
staging/prod browser corpus settings and prevents `vite.config.ts` from loading
the local `.env`. `package:lambda` then requires the controlled build metadata,
checks the 200 MiB uncompressed application budget, and reopens the ZIP to
verify its contents and executable mode.
At cold start, `run.sh` rejects an artifact whose build environment does not
match the runtime stack's `APP_ENVIRONMENT`.

The ignored output is `infra/app/artifacts/app-runtime.zip`. The script prints
its byte count and SHA-256. A later authorized process must upload that exact
file to the foundation artifact bucket and record the returned S3 `VersionId`.
The runtime template requires the bucket, key, and version so code deployment is
immutable and reproducible.

## Sanitized parameter examples

The examples contain invalid account IDs, replacement markers, and `.invalid`
hosts. They are review inputs, not deployment-ready values:

- `parameters/testing-runtime.parameters.json` (adopts existing
  Cognito/Dynamo/S3/Aurora IDs; do not apply `app-foundation.cfn.yaml`)
- `parameters/staging-foundation.parameters.json`
- `parameters/staging-runtime.parameters.json`
- `parameters/prod-foundation.parameters.json`
- `parameters/prod-runtime.parameters.json`

Replace every `replace-with-*`, every `000000000000`, and every `.invalid`
host. The runtime template pins the official arm64 and x86_64 adapter layer ARNs
for `us-east-1`; changing the adapter version requires a reviewed template
change.

Because the first CloudFront hostname is not known until the runtime exists, a
greenfield staging rollout needs a reviewed two-step callback update:

1. Create the staging foundation with temporary HTTPS `.invalid` callback,
   logout, and app-origin values.
2. Create the staging runtime from an immutable artifact version.
3. Use `CloudFrontUrl` to update the foundation callback/logout/app-origin
   values, then pass those exact updated outputs to the runtime.
4. Complete Cognito cookie, callback, SSE, origin-gate, WAF, and rollback tests.
5. Repeat for prod only after staging acceptance.

Those are sequencing notes only. This repository runbook does not authorize the
AWS operations.

Secrets Manager rotation does not by itself refresh values copied into Lambda,
API Gateway, or CloudFront properties. Rotate the origin key with an overlap
window and a coordinated runtime-stack update; do not remove the previous
working value until the new distribution and API key have propagated.

## Local validation only

These commands do not call AWS:

```powershell
cfn-lint `
  .\infra\app\app-foundation.cfn.yaml `
  .\infra\app\app-runtime.cfn.yaml `
  .\db\kb\infra\kb-aurora.cfn.yaml

node --experimental-strip-types --test `
  .\src\lib\auth\production-config.test.ts `
  .\src\lib\auth\production-iac.test.ts `
  .\src\lib\kb\aurora.server.test.ts

bun run test
bunx tsc --noEmit
bun run build
bun run package:lambda
git diff --check
```

Do not substitute `aws cloudformation validate-template`; it still invokes an
AWS API. Do not upload the generated ZIP during local validation.

Before any separately authorized deployment review, also verify:

- The target is a new staging or prod stack name and no parameter contains a
  development physical name.
- All producer ARNs come from the intended environment and account.
- The CloudFormation execution role can read the versioned artifact and resolve
  only the origin-access and corpus service secrets, including their KMS keys.
- The pinned Lambda Web Adapter owner/version and selected architecture.
- The selected API Gateway integration timeout, its effect on regional account
  throttling, and the regional account logging role.
- Cognito callback/logout URLs exactly match the CloudFront hostname.
- The managed CloudFront policy IDs still identify CachingDisabled,
  AllViewerExceptHostHeader, and CachingOptimized.
- WAF false-positive behavior for legal-document uploads and authenticated APIs.
- Alarm routing, reserved concurrency, cost, recovery, and rollback procedures.
