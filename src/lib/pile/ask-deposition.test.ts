import assert from "node:assert/strict";
import { test } from "node:test";

import { BedrockError } from "@/lib/agents/bedrock.server";

import { depositionModelChain, shouldFallThrough } from "./ask-deposition.server.ts";

test("default chain keeps the live order and appends Claude as the last fallback", () => {
  assert.deepEqual(depositionModelChain({}), ["zai.glm-5", "nvidia.nemotron-super-3-120b", "us.anthropic.claude-sonnet-5"]);
});

test("DEPOSITION_FALLBACK_MODEL=off restores the exact pre-existing chain", () => {
  assert.deepEqual(depositionModelChain({ DEPOSITION_FALLBACK_MODEL: "off" }), ["zai.glm-5", "nvidia.nemotron-super-3-120b"]);
});

test("DEPOSITION_MODELS overrides the chain; the fallback is appended once", () => {
  assert.deepEqual(depositionModelChain({ DEPOSITION_MODELS: "us.anthropic.claude-haiku-4-5-20251001-v1:0, zai.glm-5" }), [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "zai.glm-5",
    "us.anthropic.claude-sonnet-5",
  ]);
  assert.deepEqual(depositionModelChain({ DEPOSITION_MODELS: "us.anthropic.claude-sonnet-5" }), ["us.anthropic.claude-sonnet-5"]);
  assert.deepEqual(depositionModelChain({ DEPOSITION_MODELS: "zai.glm-5", DEPOSITION_FALLBACK_MODEL: "nvidia.nemotron-super-3-120b" }), [
    "zai.glm-5",
    "nvidia.nemotron-super-3-120b",
  ]);
});

test("access, throttling and capacity errors fall through; aborts and unknown errors do not", () => {
  for (const status of [400, 403, 404, 429, 500, 503]) {
    assert.equal(shouldFallThrough(new BedrockError(status, `status ${status}`)), true, `status ${status}`);
  }
  assert.equal(shouldFallThrough(new BedrockError(422, "bad request")), false);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(shouldFallThrough(abort), false);
  assert.equal(shouldFallThrough(new Error("network down")), false);
});
