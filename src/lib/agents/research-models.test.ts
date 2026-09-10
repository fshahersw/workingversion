import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FAST_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_ROUTER_MODEL,
  frontierEnabled,
  isClaudeModel,
  isGrokModel,
  loadFastModel,
  loadFastWriterModel,
  loadOrchestratorModel,
  loadRouterModel,
  loadWriterModel,
  loopModel,
  writerModel,
} from "./research-models.ts";

test("research model defaults to Sonnet 5 and honors the env override", () => {
  assert.equal(loadFastWriterModel({}), DEFAULT_RESEARCH_MODEL);
  assert.equal(
    loadFastWriterModel({ BEDROCK_RESEARCH_MODEL: "us.anthropic.claude-opus-5" }),
    "us.anthropic.claude-opus-5",
  );
});

test("fast loop model: local dev defaults to Nemotron, hosted stays on research unless set", () => {
  // Local dev (no hosted markers) exercises Nemotron.
  assert.equal(loadFastModel({ NODE_ENV: "development" }), DEFAULT_FAST_MODEL);
  // Hosted runtimes stay on the research model so a deploy cannot silently switch.
  assert.equal(loadFastModel({ NODE_ENV: "production" }), DEFAULT_RESEARCH_MODEL);
  assert.equal(loadFastModel({ APP_ENVIRONMENT: "prod" }), DEFAULT_RESEARCH_MODEL);
  assert.equal(loadFastModel({ APP_ENVIRONMENT: "staging" }), DEFAULT_RESEARCH_MODEL);
  // Explicit override wins everywhere (including hosted) — the opt-in path.
  assert.equal(
    loadFastModel({ APP_ENVIRONMENT: "prod", BEDROCK_FAST_MODEL: "nvidia.nemotron-super-3-120b" }),
    "nvidia.nemotron-super-3-120b",
  );
});

test("fast splits the loop from the writer; think stays one model", () => {
  const dev = { NODE_ENV: "development" } as const;
  assert.equal(loopModel("fast", dev), DEFAULT_FAST_MODEL);
  assert.equal(writerModel("fast", dev), DEFAULT_RESEARCH_MODEL);
  assert.equal(loopModel("think", dev), DEFAULT_RESEARCH_MODEL);
  assert.equal(writerModel("think", dev), DEFAULT_RESEARCH_MODEL);
});

test("isClaudeModel gates Claude-only cache and adaptive-thinking fields", () => {
  assert.equal(isClaudeModel("us.anthropic.claude-sonnet-5"), true);
  assert.equal(isClaudeModel("us.anthropic.claude-opus-5"), true);
  assert.equal(isClaudeModel("nvidia.nemotron-super-3-120b"), false);
});

test("frontier model selectors default in-account and honor env overrides", () => {
  assert.equal(loadRouterModel({}), DEFAULT_ROUTER_MODEL);
  assert.equal(loadRouterModel({ NEMOTRON_MODEL_ID: "nvidia.custom" }), "nvidia.custom");

  assert.equal(loadOrchestratorModel({}), DEFAULT_GROK_MODEL);
  assert.equal(loadWriterModel({}), DEFAULT_GROK_MODEL);
  // GROK_MODEL_ID is the shared fallback; the role-specific var wins over it.
  assert.equal(loadOrchestratorModel({ GROK_MODEL_ID: "global.xai.grok-4.6" }), "global.xai.grok-4.6");
  assert.equal(
    loadWriterModel({ GROK_MODEL_ID: "global.xai.grok-4.6", GROK_WRITER_MODEL: "us.xai.grok-4.6" }),
    "us.xai.grok-4.6",
  );
});

test("frontierEnabled is OFF unless FRONTIER_AGENT is truthy", () => {
  assert.equal(frontierEnabled({}), false);
  assert.equal(frontierEnabled({ FRONTIER_AGENT: "0" }), false);
  assert.equal(frontierEnabled({ FRONTIER_AGENT: "off" }), false);
  assert.equal(frontierEnabled({ FRONTIER_AGENT: "1" }), true);
  assert.equal(frontierEnabled({ FRONTIER_AGENT: "true" }), true);
  assert.equal(frontierEnabled({ FRONTIER_AGENT: "on" }), true);
});

test("isGrokModel gates the temperature field off for Grok", () => {
  assert.equal(isGrokModel("us.xai.grok-4.6"), true);
  assert.equal(isGrokModel("xai.grok-4.6"), true);
  assert.equal(isGrokModel("us.anthropic.claude-sonnet-5"), false);
  assert.equal(isGrokModel("nvidia.nemotron-super-3-120b"), false);
});
