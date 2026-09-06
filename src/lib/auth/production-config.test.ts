import assert from "node:assert/strict";
import { test } from "node:test";

import {
  envOrDevDefault,
  loadAgentCoreConfig,
  loadBdaConfig,
  loadCognitoConfig,
  loadCorpusConfig,
  loadDynamoConfig,
  loadKbConfig,
  loadS3Config,
  requiredEnv,
  type EnvSource,
} from "../config.server.ts";

type Loader = (env: EnvSource) => unknown;

function without(
  env: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function assertRequired(
  loader: Loader,
  complete: Record<string, string>,
  names: readonly string[],
): void {
  assert.throws(
    () => loader(without(complete, names)),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        `Missing required environment variable: ${names.join(" or ")}`,
  );
}

test("production requires every Cognito setting and always secures cookies", () => {
  const env = {
    NODE_ENV: "production",
    COGNITO_REGION: "test-region",
    COGNITO_USER_POOL_ID: "test-pool",
    COGNITO_CLIENT_ID: "test-client",
    COGNITO_DOMAIN: "auth.example.test",
    COGNITO_REDIRECT_URI: "http://auth.example.test/callback",
    COGNITO_LOGOUT_URI: "http://auth.example.test/logout",
  };
  for (const name of [
    "COGNITO_REGION",
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_DOMAIN",
    "COGNITO_REDIRECT_URI",
    "COGNITO_LOGOUT_URI",
  ]) {
    assertRequired(loadCognitoConfig, env, [name]);
  }
  assert.equal(loadCognitoConfig(env).secureCookies, true);
});

test("production requires DynamoDB and S3 deployment settings", () => {
  const dynamo = {
    NODE_ENV: "production",
    SW_DDB_TABLE: "test-table",
    AWS_REGION: "test-region",
  };
  assertRequired(loadDynamoConfig, dynamo, ["SW_DDB_TABLE"]);
  assertRequired(loadDynamoConfig, dynamo, ["AWS_REGION"]);

  const s3 = {
    NODE_ENV: "production",
    SW_S3_BUCKET: "test-bucket",
    AWS_REGION: "test-region",
  };
  assertRequired(loadS3Config, s3, ["SW_S3_BUCKET"]);
  assertRequired(loadS3Config, s3, ["AWS_REGION"]);
});

test("production requires every KB deployment setting", () => {
  const env = {
    NODE_ENV: "production",
    AWS_REGION: "test-region",
    KB_CLUSTER_ARN: "test-cluster-arn",
    KB_SECRET_ARN: "test-secret-arn",
    KB_DATABASE: "test-database",
  };
  assertRequired(loadKbConfig, env, ["KB_CLUSTER_ARN"]);
  assertRequired(loadKbConfig, env, ["KB_SECRET_ARN"]);
  assertRequired(loadKbConfig, env, ["KB_DATABASE"]);
  assert.deepEqual(loadKbConfig(env), {
    clusterArn: "test-cluster-arn",
    secretArn: "test-secret-arn",
    database: "test-database",
    region: "test-region",
  });
});

test("production corpus config accepts either public env naming convention", () => {
  const env = {
    NODE_ENV: "production",
    CORPUS_URL: "https://corpus.example.test",
    CORPUS_KEY: "test-publishable-key",
  };
  assertRequired(loadCorpusConfig, env, ["VITE_CORPUS_URL", "CORPUS_URL"]);
  assertRequired(loadCorpusConfig, env, ["VITE_CORPUS_KEY", "CORPUS_KEY"]);
  assert.doesNotThrow(() =>
    loadCorpusConfig({
      NODE_ENV: "production",
      VITE_CORPUS_URL: "https://corpus.example.test",
      VITE_CORPUS_KEY: "test-publishable-key",
    }),
  );
});

test("production requires BDA and AgentCore settings", () => {
  const bda = {
    NODE_ENV: "production",
    AWS_REGION: "test-region",
    BDA_PROJECT_ARN: "test-project-arn",
    BDA_PROFILE_ARN: "test-profile-arn",
  };
  assertRequired(loadBdaConfig, bda, ["BEDROCK_REGION", "AWS_REGION"]);
  assertRequired(loadBdaConfig, bda, ["BDA_PROJECT_ARN"]);
  assertRequired(loadBdaConfig, bda, ["BDA_PROFILE_ARN"]);

  const agentCore = {
    NODE_ENV: "production",
    AGENTCORE_SEARCH_URL: "https://search.example.test/mcp",
    AGENTCORE_SEARCH_TOOL: "test-search-tool",
    AWS_REGION: "test-region",
  };
  assertRequired(loadAgentCoreConfig, agentCore, ["AGENTCORE_SEARCH_URL"]);
  assertRequired(loadAgentCoreConfig, agentCore, ["AGENTCORE_SEARCH_TOOL"]);
  assertRequired(loadAgentCoreConfig, agentCore, ["BEDROCK_REGION", "AWS_REGION"]);
});

test("non-production keeps local defaults and errors never include env values", () => {
  const development = { NODE_ENV: "development" };
  for (const loader of [
    loadCognitoConfig,
    loadDynamoConfig,
    loadS3Config,
    loadKbConfig,
    loadCorpusConfig,
    loadBdaConfig,
    loadAgentCoreConfig,
  ]) {
    assert.doesNotThrow(() => loader(development));
  }
  assert.equal(loadCognitoConfig(development).secureCookies, false);

  const marker = "value-must-not-appear";
  assert.throws(
    () => requiredEnv("CORPUS_SERVICE_KEY", development),
    /CORPUS_SERVICE_KEY/,
  );
  assert.throws(
    () =>
      envOrDevDefault("MISSING_SETTING", "local-default", {
        NODE_ENV: "production",
        UNRELATED_SETTING: marker,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("MISSING_SETTING") &&
      !error.message.includes(marker) &&
      !error.message.includes("local-default"),
  );
});
