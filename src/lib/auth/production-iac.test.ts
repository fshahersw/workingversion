import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function text(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

const foundation = text("../../../infra/app/app-foundation.cfn.yaml");
const runtime = text("../../../infra/app/app-runtime.cfn.yaml");
const kb = text("../../../db/kb/infra/kb-aurora.cfn.yaml");
const runScript = text("../../../infra/app/runtime/run.sh");
const packager = text("../../../scripts/package-lambda.mjs");
const lambdaBuilder = text("../../../scripts/build-lambda.mjs");
const migrationScript = text("../../../scripts/kb-apply-migration.mjs");
const auroraClient = text("../kb/aurora.server.ts");
const corpusClient = text("../corpus.ts");
const heartbeat = text("../sse.server.ts");
const viteConfig = text("../../../vite.config.ts");

test("runtime uses REST Lambda proxy response streaming for root and proxy", () => {
  assert.equal(count(runtime, /Type: AWS::ApiGateway::Method/g), 2);
  assert.equal(count(runtime, /ResponseTransferMode: STREAM/g), 2);
  assert.equal(
    count(runtime, /\/response-streaming-invocations"/g),
    2,
  );
  assert.equal(count(runtime, /IntegrationHttpMethod: POST/g), 2);
  assert.equal(count(runtime, /Type: AWS_PROXY/g), 2);
  assert.match(runtime, /Type: AWS::ApiGateway::RestApi/);
  assert.equal(count(runtime, /Type: AWS::ApiGateway::Deployment/g), 2);
  assert.match(runtime, /ApiDeploymentSlot:/);
  assert.match(runtime, /UseBlueDeployment:/);
  assert.match(runtime, /UseGreenDeployment:/);
  assert.doesNotMatch(runtime, /AWS::ApiGatewayV2|AWS::Lambda::Url/);
});

test("Lambda Web Adapter and Nitro use the non-reserved streaming port", () => {
  assert.match(viteConfig, /nitro:\s*\{\s*\n\s*preset: "node-server"/);
  assert.match(runtime, /Runtime: nodejs22\.x/);
  assert.match(runtime, /Handler: run\.sh/);
  assert.match(runtime, /AWS_LAMBDA_EXEC_WRAPPER: \/opt\/bootstrap/);
  assert.match(runtime, /AWS_LWA_INVOKE_MODE: response_stream/);
  assert.match(runtime, /LambdaAdapterLayers:/);
  assert.match(runtime, /LambdaAdapterLayerArm64:28/);
  assert.match(runtime, /LambdaAdapterLayerX86:28/);
  assert.doesNotMatch(runtime, /LambdaWebAdapterLayerArn:/);
  assert.match(runtime, /AWS_LWA_PORT: "8080"/);
  assert.match(runtime, /PORT: "8080"/);
  assert.doesNotMatch(runtime, /^\s+AWS_REGION:/m);
  assert.equal(runScript.includes("\r"), false);
  assert.match(runScript, /^#!\/bin\/sh\n/);
  assert.match(runScript, /build-metadata\.json/);
  assert.match(runScript, /APP_ENVIRONMENT/);
  assert.match(runScript, /exec node server\/index\.mjs\n$/);
});

test("CloudFront caches only immutable assets and preserves authenticated state", () => {
  assert.match(runtime, /DefaultCacheBehavior:[\s\S]*CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(runtime, /OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  assert.match(runtime, /PathPattern: \/assets\/\*/);
  assert.match(runtime, /PathPattern: \/assets\/\*[\s\S]*CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6/);
  assert.match(runtime, /DefaultCacheBehavior:[\s\S]*Compress: false/);
  const behaviors = [...runtime.matchAll(/PathPattern:\s+(\S+)/g)];
  assert.deepEqual(behaviors.map(match => match[1]), ["/assets/*", "/engine/*", "/archive-api/*", "/workbench-api/*"]);
  for (let i = 0; i < behaviors.length; i++) {
    const behavior = behaviors[i]!;
    const block = runtime.slice(behavior.index, behaviors[i + 1]?.index);
    const expected = behavior[1] === "/assets/*" ? "658327ea-f89d-4fab-a63d-7e88639e58f6" : "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
    assert.equal(/CachePolicyId:\s+(\S+)/.exec(block)?.[1], expected, `${behavior[1]} cache policy`);
    if (behavior[1] !== "/assets/*") assert.match(block, /OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  }
});

test("all streamed API routes emit heartbeats below the CloudFront idle timeout", () => {
  assert.match(heartbeat, /SSE_HEARTBEAT_MS = 25_000/);
  assert.match(runtime, /CloudFrontOriginReadTimeout:[\s\S]*Default: 120/);
  for (const route of [
    "orchestrate",
    "summarize",
    "quick-ask",
    "pile/ask",
    "kb/ask",
  ]) {
    assert.match(
      text(`../../routes/api/${route}.ts`),
      /startSseHeartbeat/,
      `${route} must keep the streaming origin connection alive`,
    );
  }
});

test("CloudFront origin access and WAF cannot be silently bypassed", () => {
  assert.equal(
    count(
      runtime,
      /\{\{resolve:secretsmanager:\$\{OriginAccessSecretArn\}:SecretString:originKey\}\}/g,
    ),
    2,
  );
  assert.equal(count(runtime, /ApiKeyRequired: true/g), 2);
  assert.match(runtime, /HeaderName: x-api-key/);
  assert.match(runtime, /WebACLId: !GetAtt WebAcl\.Arn/);
  assert.match(runtime, /AWSManagedRulesCommonRuleSet/);
  assert.match(
    runtime,
    /Name: SizeRestrictions_BODY\s*\n\s*ActionToUse:\s*\n\s*Count: \{\}/,
  );
  assert.match(runtime, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(runtime, /RateBasedStatement:/);
});

test("runtime consumes producer policies and never embeds secret values", () => {
  assert.match(runtime, /ManagedPolicyArns:\s*\n\s*- !Ref AppAccessPolicyArn\s*\n\s*- !Ref KbAccessPolicyArn/);
  assert.match(runtime, /KB_SECRET_ARN: !Ref KbSecretArn/);
  assert.match(runtime, /KbSecretArn:[\s\S]*ARN for Data API calls/);
  assert.match(
    runtime,
    /CORPUS_SERVICE_KEY: !Sub "\{\{resolve:secretsmanager:\$\{CorpusServiceSecretArn\}:SecretString:CORPUS_SERVICE_KEY\}\}"/,
  );
  assert.doesNotMatch(runtime, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|KB_APP_SECRET_ARN/);
  assert.doesNotMatch(runtime, /SecretString:\s*["'][^{}]/);
  assert.doesNotMatch(
    runtime,
    /\$context\.(requestOverride|authorizer|identity|path|resourcePath|protocol\.)/,
  );
});

test("foundation owns a retained private versioned artifact mechanism", () => {
  assert.match(foundation, /AWSAgentToolkit: aws-cloudformation@2/);
  assert.match(
    foundation,
    /DeploymentArtifactBucket:\s*\n\s*Type: AWS::S3::Bucket\s*\n\s*DeletionPolicy: Retain\s*\n\s*UpdateReplacePolicy: Retain/,
  );
  assert.match(foundation, /DeploymentArtifactBucket:[\s\S]*SSEAlgorithm: aws:kms/);
  assert.match(foundation, /DeploymentArtifactBucket:[\s\S]*BlockPublicAcls: true/);
  assert.match(foundation, /DeploymentArtifactBucket:[\s\S]*VersioningConfiguration:\s*\n\s*Status: Enabled/);
  assert.match(foundation, /DeploymentArtifactBucketPolicy:[\s\S]*"aws:SecureTransport": "false"/);
  assert.match(foundation, /DeploymentArtifactBucketName:/);
  assert.match(foundation, /DeploymentArtifactBucketArn:/);
  assert.match(foundation, /CloudFrontOriginAccessSecretArn:/);
});

test("foundation scopes BDA and AgentCore permissions to configured resources", () => {
  assert.match(foundation, /Sid: BedrockRerankApi[\s\S]*bedrock:Rerank[\s\S]*Resource: "\*"/);
  assert.match(foundation, /Sid: BedrockRerankModel[\s\S]*bedrock:InvokeModel/);
  assert.match(foundation, /bedrock:InvokeDataAutomationAsync/);
  assert.match(foundation, /data-automation-invocation\/\*/);
  assert.match(foundation, /bedrock-agentcore:InvokeGateway/);
  assert.match(foundation, /bedrock-agentcore:StartCodeInterpreterSession/);
  assert.match(foundation, /Resource:\s*\n\s*- !Ref AgentCoreGatewayArn/);
  assert.match(foundation, /Resource:\s*\n\s*- !Ref AgentCoreCodeInterpreterResourceArn/);
});

test("KB template preserves cluster defaults and adds non-destructive alarms", () => {
  assert.match(kb, /AWSAgentToolkit: aws-cloudformation@2/);
  assert.match(kb, /MinCapacity:\s*\n\s*Type: Number\s*\n\s*Default: 0/);
  assert.match(kb, /MaxCapacity:\s*\n\s*Type: Number\s*\n\s*Default: 4/);
  assert.match(kb, /BackupRetentionDays:\s*\n\s*Type: Number\s*\n\s*Default: 7/);
  assert.match(kb, /KbCluster:[\s\S]*DeletionPolicy: Snapshot\s*\n\s*UpdateReplacePolicy: Snapshot/);
  assert.match(kb, /Sid: KbAppSecretKmsDecrypt/);
  assert.match(kb, /"kms:ViaService": !Sub "secretsmanager\.\$\{AWS::Region\}\.\$\{AWS::URLSuffix\}"/);
  assert.match(kb, /MetricName: CPUUtilization/);
  assert.match(kb, /MetricName: DatabaseConnections/);
  assert.match(kb, /MetricName: ServerlessDatabaseCapacity/);
});

test("KB runtime and migration resolve configuration at use time", () => {
  assert.match(auroraClient, /loadKbConfig\(\)/);
  assert.doesNotMatch(auroraClient, /const (CLUSTER_ARN|SECRET_ARN|DATABASE)\s*=/);
  assert.match(
    migrationScript,
    /process\.env\.KB_SECRET_ARN \|\| process\.env\.KB_APP_SECRET_ARN/,
  );
});

test("packager creates deterministic Unix-mode entries without extra dependencies", () => {
  assert.match(packager, /\.output\/server/);
  assert.match(packager, /\.output\/public/);
  assert.match(packager, /unixPermissions: 0o100755/);
  assert.match(packager, /unixPermissions: 0o100644/);
  assert.match(packager, /platform: "UNIX"/);
  assert.match(packager, /new Date\(1980, 0, 1, 0, 0, 0\)/);
  assert.match(packager, /nitroMetadata\?\.preset !== "node-server"/);
  assert.match(packager, /maxUncompressedBytes = 200 \* 1024 \* 1024/);
  assert.match(packager, /JSZip\.loadAsync\(bytes\)/);
  assert.match(packager, /build-metadata\.json/);
  assert.match(packager, /run\.sh contains CRLF line endings/);
});

test("testing deploy updates the runtime stack without applying foundation", () => {
  const deploy = text("../../../scripts/deploy-testing.mjs");
  const testingRuntime = text("../../../infra/app/parameters/testing-runtime.parameters.json");
  const testingHosting = text("../../../infra/app/testing-hosting.cfn.yaml");
  assert.match(deploy, /create-change-set/);
  assert.match(deploy, /change-set-type[\s\S]*UPDATE/);
  assert.match(deploy, /litai-testing-runtime/);
  assert.match(deploy, /LITAI_BUILD_ENVIRONMENT: "testing"/);
  assert.doesNotMatch(deploy, /app-foundation\.cfn\.yaml/);
  assert.match(testingHosting, /Does not\s+create a second user pool/);
  assert.match(testingRuntime, /"Environment",\s*"ParameterValue": "testing"/);
  assert.match(testingRuntime, /sw-dev-app/);
  assert.doesNotMatch(testingRuntime, /replace-with-/);
});

test("Lambda builds require explicit environment inputs and never load local .env", () => {
  assert.match(lambdaBuilder, /LITAI_BUILD_ENVIRONMENT/);
  assert.match(lambdaBuilder, /VITE_CORPUS_URL and VITE_CORPUS_KEY must be supplied explicitly/);
  assert.match(lambdaBuilder, /LITAI_LAMBDA_BUILD = "true"/);
  assert.match(viteConfig, /LITAI_LAMBDA_BUILD.*=== "true".*return/);
  assert.match(corpusClient, /typeof window === "undefined" && runtime/);
  assert.match(corpusClient, /CORPUS_URL: runtime\["CORPUS_URL"\]/);
});

test("sanitized staging and prod examples contain no live account identifiers", () => {
  for (const name of [
    "staging-foundation",
    "staging-runtime",
    "prod-foundation",
    "prod-runtime",
  ]) {
    const source = text(`../../../infra/app/parameters/${name}.parameters.json`);
    const parsed = JSON.parse(source) as Array<{
      ParameterKey: string;
      ParameterValue: string;
    }>;
    assert.ok(parsed.length > 0);
    assert.doesNotMatch(source, /475976462949|sw-dev/);
    assert.match(source, /000000000000|\.invalid|replace-with-/);
    const environment = parsed.find((item) => item.ParameterKey === "Environment");
    assert.equal(environment?.ParameterValue, name.startsWith("prod") ? "prod" : "staging");
    if (name.endsWith("runtime")) {
      assert.equal(
        parsed.some((item) => item.ParameterKey === "LambdaWebAdapterLayerArn"),
        false,
      );
      assert.match(
        parsed.find((item) => item.ParameterKey === "AppAccessPolicyArn")
          ?.ParameterValue ?? "",
        /:policy\/lit-ai\/(staging|prod)\//,
      );
    }
  }
});

test("production templates never reference development names or static AWS keys", () => {
  for (const source of [foundation, runtime, kb]) {
    assert.doesNotMatch(source, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  }
  assert.doesNotMatch(foundation, /sw-dev/i);
  assert.doesNotMatch(runtime, /sw-dev/i);
  assert.doesNotMatch(kb, /sw-dev/i);
});
