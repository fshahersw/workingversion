# Application foundation CloudFormation

> **NO DEPLOY:** This directory is an Infrastructure as Code deliverable only.
> Do not run `deploy`, `execute-change-set`, `create-stack`, or `update-stack`
> from this runbook until the target environment, names, IAM execution role,
> costs, and change set have been reviewed.

`app-foundation.cfn.yaml` describes app-layer resources for a **new
environment**. It does not import, discover, reference by name, or adopt the
resources already running in the development account.

## Scope

The template creates:

- One on-demand DynamoDB table with `PK`/`SK`, `GSI1`, `GSI2`, point-in-time
  recovery, deletion protection, KMS encryption, and TTL on the numeric `ttl`
  attribute.
- One private, versioned S3 bucket with Block Public Access, bucket-owner
  enforced object ownership, a TLS-only bucket policy, KMS encryption with
  bucket keys, one parameterized CORS origin, and lifecycle cleanup for
  incomplete uploads and noncurrent versions.
- One rotating customer-managed KMS key and environment-specific alias.
- One Cognito user pool, public web client, and managed domain configured for
  OIDC authorization code with PKCE. The client has no secret and allows only
  the `code` OAuth flow with `openid email profile` scopes.
- An optional Cognito group named `admin`. The name is intentional because the
  application maps the `admin` group claim to its admin role.
- One IAM managed policy for the table, indexes, bucket, KMS key, application
  log group, and optional exact Bedrock, RDS Data API, Secrets Manager, and
  secret KMS resources.
- One KMS-encrypted CloudWatch log group and alarms for DynamoDB read/write
  throttles and S3 `5xxErrors`. The S3 request-metrics configuration has a
  CloudWatch cost.

The IAM policy is output but is not attached to a role. The application compute
platform and runtime role are deliberately not invented here.

This template also deliberately excludes WAF and rate-limiting resources. The
deployment stack that owns the public CloudFront distribution, API Gateway,
load balancer, or other ingress must attach the appropriate WAF web ACL and
service-native throttling there. A WAF resource without an association target
would not protect the application.

## Existing development resources

Do not select `dev` and reuse the live prefix as an attempted migration.
CloudFormation does not adopt a resource because its physical name matches.
Creation will normally fail with an already-exists error, and partial stack
creation can leave retained resources requiring cleanup.

Use one of these paths:

1. Create a new named stack with a new environment identifier and new physical
   names, then migrate data through a reviewed application/data migration.
2. Build a separate, resource-by-resource CloudFormation import plan for
   development. Confirm that each resource type supports import, capture its
   exact live configuration and identifier, model dependencies in safe stages,
   and use an `IMPORT` change set. Importing a bucket or table does not
   automatically import its policies, KMS key, aliases, Cognito domain, groups,
   alarms, or IAM policies.

Do not run a `CREATE` or `UPDATE` change set over live names to simulate import.
Do not change retained resource names in place without a replacement and data
migration plan.

Physical names include both `NamePrefix` and `Environment`. The bucket is:

`{NamePrefix}-{Environment}-{AWS account ID}-{AWS Region}-data`

The Cognito managed-domain prefix also includes the AWS account ID. A name
collision causes stack creation to fail; it does not transfer ownership to the
stack.

## Application configuration contract

Use stack outputs to populate runtime configuration:

- `DynamoTableName` -> `SW_DDB_TABLE`
- `S3BucketName` -> `SW_S3_BUCKET`
- `CognitoRegion` -> `COGNITO_REGION`
- `CognitoUserPoolId` -> `COGNITO_USER_POOL_ID`
- `CognitoClientId` -> `COGNITO_CLIENT_ID`
- `CognitoDomain` -> `COGNITO_DOMAIN`
- `CognitoCallbackUrl` -> `COGNITO_REDIRECT_URI`
- `CognitoLogoutUrl` -> `COGNITO_LOGOUT_URI`
- Existing Aurora stack cluster ARN -> `KB_CLUSTER_ARN`
- Existing Aurora application secret ARN -> `KB_SECRET_ARN`

The Aurora cluster and application secret remain owned by their existing,
separate stack. Pass their exact ARNs through `RdsClusterArn` and
`DatabaseSecretArns` when creating a new app-foundation stack. If a database
secret uses a customer-managed key, also pass its key ARN through
`DatabaseSecretKmsKeyArns`. These parameters grant access only; they do not
import or modify the referenced resources.

`BedrockModelResourceArns` accepts exact comma-delimited model and inference
profile ARNs. Cross-Region inference requires all applicable inference-profile
and backing foundation-model ARNs. `BedrockRerankResourceArns` is separate so
the `bedrock:Rerank` action is not granted to unrelated model resources. Empty
optional integration parameters produce no corresponding IAM statement.

Production callback, logout, and app-origin values should use HTTPS. HTTP is
accepted only to support isolated local/test environments.

## Local validation

From the repository root in PowerShell:

```powershell
cfn-lint .\infra\app\app-foundation.cfn.yaml
```

If `cfn-lint` is not installed, an isolated invocation avoids changing
`package.json`:

```powershell
pipx run cfn-lint .\infra\app\app-foundation.cfn.yaml
```

For organization-specific policy checks, point CloudFormation Guard at the
approved rule directory:

```powershell
if (-not $env:CFN_GUARD_RULES) {
  throw "Set CFN_GUARD_RULES to the approved cfn-guard rule directory."
}
cfn-guard validate `
  --rules $env:CFN_GUARD_RULES `
  --data .\infra\app\app-foundation.cfn.yaml
```

The AWS CLI validation API is read-only but still requires AWS credentials. It
was not invoked while producing this deliverable:

```powershell
aws cloudformation validate-template `
  --region us-east-1 `
  --template-body file://infra/app/app-foundation.cfn.yaml
```

## Create and inspect a non-executed change set

Creating a change set writes CloudFormation control-plane state but does not
create the template resources. It is included for a later, authorized review
session. It was not run while producing this deliverable.

Set explicit values first:

```powershell
$env:LITAI_AWS_REGION = "us-east-1"
$env:LITAI_NAME_PREFIX = "litai"
$env:LITAI_ENVIRONMENT = "staging"
$env:LITAI_APP_ORIGIN = "https://staging.example.com"
$env:LITAI_CALLBACK_URL = "https://staging.example.com/auth/callback"
$env:LITAI_LOGOUT_URL = "https://staging.example.com/"
```

Create a `CREATE` change set for a stack name that does not already exist:

```powershell
$changeSetName = "app-foundation-" + (Get-Date -Format "yyyyMMddHHmmss")

aws cloudformation create-change-set `
  --region $env:LITAI_AWS_REGION `
  --stack-name "$($env:LITAI_NAME_PREFIX)-$($env:LITAI_ENVIRONMENT)-app-foundation" `
  --change-set-name $changeSetName `
  --change-set-type CREATE `
  --description "Review only; new environment app foundation" `
  --template-body file://infra/app/app-foundation.cfn.yaml `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameters `
    "ParameterKey=NamePrefix,ParameterValue=$env:LITAI_NAME_PREFIX" `
    "ParameterKey=Environment,ParameterValue=$env:LITAI_ENVIRONMENT" `
    "ParameterKey=DeploymentIntent,ParameterValue=new-environment" `
    "ParameterKey=AppOrigin,ParameterValue=$env:LITAI_APP_ORIGIN" `
    "ParameterKey=CognitoCallbackUrl,ParameterValue=$env:LITAI_CALLBACK_URL" `
    "ParameterKey=CognitoLogoutUrl,ParameterValue=$env:LITAI_LOGOUT_URL"
```

Wait for CloudFormation to finish preparing the review artifact, then inspect
all replacements, security-sensitive changes, and IAM changes:

```powershell
aws cloudformation wait change-set-create-complete `
  --region $env:LITAI_AWS_REGION `
  --stack-name "$($env:LITAI_NAME_PREFIX)-$($env:LITAI_ENVIRONMENT)-app-foundation" `
  --change-set-name $changeSetName

aws cloudformation describe-change-set `
  --region $env:LITAI_AWS_REGION `
  --stack-name "$($env:LITAI_NAME_PREFIX)-$($env:LITAI_ENVIRONMENT)-app-foundation" `
  --change-set-name $changeSetName `
  --query "{Status:Status,Reason:StatusReason,Changes:Changes[*].ResourceChange}"
```

Delete the unexecuted review artifact after review:

```powershell
aws cloudformation delete-change-set `
  --region $env:LITAI_AWS_REGION `
  --stack-name "$($env:LITAI_NAME_PREFIX)-$($env:LITAI_ENVIRONMENT)-app-foundation" `
  --change-set-name $changeSetName
```

There is intentionally no `execute-change-set` command in this runbook.

Before any authorized deployment, also review:

- The CloudFormation execution role's permissions for KMS, IAM, DynamoDB, S3,
  Cognito, Logs, and CloudWatch.
- Globally unique bucket and Cognito domain names.
- HTTPS callback/logout/origin values and Cognito sign-up/MFA policy.
- Exact Bedrock model, inference-profile, RDS cluster, secret, and external KMS
  ARNs.
- Retention costs, S3 request-metrics costs, alarm SNS routing, backup
  requirements, and recovery tests.
- The public ingress stack's WAF association and rate-limit policy.
