import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalEndpoint, localServiceEndpoint, localSyntheticEnabled, localSyntheticRequest } from "./local-development.ts";

test("temporary provider credentials do not enable local identity or storage", () => {
  assert.equal(localSyntheticEnabled({ ANTHROPIC_API_KEY: "synthetic" }), false);
  assert.equal(localServiceEndpoint("s3", { LOCAL_S3_ENDPOINT: "http://127.0.0.1:4568" }), undefined);
});
test("local mode refuses production and hosted runtimes", () => {
  for (const patch of [
    { NODE_ENV: "production" }, { APP_ENVIRONMENT: "testing" }, { APP_ENVIRONMENT: "staging" },
    { APP_ENVIRONMENT: "prod" }, { AWS_LAMBDA_FUNCTION_NAME: "app" }, { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs22.x" },
    { ECS_CONTAINER_METADATA_URI: "http://metadata" }, { ECS_CONTAINER_METADATA_URI_V4: "http://metadata" },
  ]) assert.throws(() => localSyntheticEnabled({ LOCAL_SYNTHETIC_MODE: "1", ...patch }));
  assert.equal(localSyntheticEnabled({ LOCAL_SYNTHETIC_MODE: "1", APP_ENVIRONMENT: "local" }), true);
});
test("local services cannot use cloud endpoints or ambient credentials by omission", () => {
  assert.throws(() => localServiceEndpoint("dynamo", { LOCAL_SYNTHETIC_MODE: "1" }));
  for (const endpoint of ["https://s3.amazonaws.com", "http://127.0.0.1.evil.test:9000", "http://user:pass@localhost:9000", "http://localhost:9000/path", "http://localhost:9000/?x=1"]) {
    assert.throws(() => assertLocalEndpoint(endpoint));
  }
  assert.equal(assertLocalEndpoint("http://127.0.0.1:4568"), "http://127.0.0.1:4568");
});
test("local synthetic identity rejects foreign origins and remote hostnames", () => {
  const env = { LOCAL_SYNTHETIC_MODE: "1" };
  assert.equal(localSyntheticRequest(new Request("http://127.0.0.1:5189/api/auth/me"), env), true);
  assert.throws(() => localSyntheticRequest(new Request("http://testing.seegerweiss.com/api/auth/me"), env));
  assert.throws(() => localSyntheticRequest(new Request("http://127.0.0.1:5189/api/auth/me", {headers:{origin:"https://example.com"}}), env));
  assert.throws(() => localSyntheticRequest(new Request("http://127.0.0.1:5189/api/auth/me", {headers:{"sec-fetch-site":"cross-site"}}), env));
});
