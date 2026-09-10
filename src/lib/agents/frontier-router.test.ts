import assert from "node:assert/strict";
import { test } from "node:test";

import type { RequestContext } from "./frontier-contracts.ts";
import {
  buildRouterUser,
  fallbackRoutePlan,
  latencyClassOf,
  normalizeRoutePlan,
  parseRoutePlan,
} from "./frontier-router.ts";

test("parseRoutePlan reads a clean RoutePlan JSON", () => {
  const raw = JSON.stringify({
    intent: "docket_status",
    complexity: "standard",
    freshness: "current_required",
    needsTools: true,
    needsGrokPlanner: false,
    grokReasoning: "low",
    toolFamilies: ["courtlistener", "docketbird"],
    canParallelize: true,
    maxResearchRounds: 2,
    needsChoicePanel: false,
    answerStyle: "normal",
    rationaleCode: "CURRENT_DOCKET_LOOKUP",
  });
  const route = parseRoutePlan(raw);
  assert.ok(route);
  assert.equal(route.intent, "docket_status");
  assert.equal(route.maxResearchRounds, 2);
  assert.deepEqual(route.toolFamilies, ["courtlistener", "docketbird"]);
  assert.equal(route.rationaleCode, "CURRENT_DOCKET_LOOKUP");
});

test("parseRoutePlan recovers JSON wrapped in prose / code fence", () => {
  const raw = 'Here is the plan:\n```json\n{"intent":"rewrite","complexity":"fast","needsTools":false}\n```';
  const route = parseRoutePlan(raw);
  assert.ok(route);
  assert.equal(route.intent, "rewrite");
  assert.equal(route.needsTools, false);
});

test("parseRoutePlan returns null on non-JSON", () => {
  assert.equal(parseRoutePlan("I cannot route this."), null);
});

test("normalize clamps research rounds to the per-complexity ceiling (§4)", () => {
  const deep = normalizeRoutePlan({ complexity: "deep", needsTools: true, maxResearchRounds: 99 });
  assert.equal(deep.maxResearchRounds, 6);
  const fast = normalizeRoutePlan({ complexity: "fast", needsTools: true, maxResearchRounds: 5 });
  assert.equal(fast.maxResearchRounds, 1);
});

test("normalize forces 0 rounds and no tool families when needsTools is false", () => {
  const r = normalizeRoutePlan({
    complexity: "standard",
    needsTools: false,
    maxResearchRounds: 4,
    toolFamilies: ["web", "courtlistener"],
  });
  assert.equal(r.maxResearchRounds, 0);
  assert.deepEqual(r.toolFamilies, []);
});

test("normalize coerces invalid enums to safe defaults", () => {
  const r = normalizeRoutePlan({
    intent: "banana",
    complexity: "ludicrous",
    freshness: "maybe",
    grokReasoning: "ultra",
    answerStyle: "novella",
  });
  assert.equal(r.intent, "legal_research");
  assert.equal(r.complexity, "standard");
  assert.equal(r.freshness, "recent_preferred");
  assert.equal(r.grokReasoning, "low");
  assert.equal(r.answerStyle, "normal");
});

test("normalize drops unknown tool families and dedupes", () => {
  const r = normalizeRoutePlan({
    needsTools: true,
    toolFamilies: ["web", "web", "pigeon", "sec"],
  });
  assert.deepEqual(r.toolFamilies, ["web", "sec"]);
});

test("normalize defaults planner/reasoning higher for deep complexity", () => {
  const r = normalizeRoutePlan({ complexity: "deep", needsTools: true });
  assert.equal(r.needsGrokPlanner, true);
  assert.equal(r.grokReasoning, "high");
});

test("rationaleCode is sanitized to UPPER_SNAKE_CASE", () => {
  assert.equal(normalizeRoutePlan({ rationaleCode: "current docket lookup!" }).rationaleCode, "CURRENT_DOCKET_LOOKUP");
  assert.equal(normalizeRoutePlan({}).rationaleCode, "UNSPECIFIED");
});

test("fallbackRoutePlan is a safe grounded standard research route", () => {
  const r = fallbackRoutePlan();
  assert.equal(r.needsTools, true);
  assert.equal(r.complexity, "standard");
  assert.equal(r.maxResearchRounds, 2);
  assert.equal(r.rationaleCode, "ROUTER_FALLBACK");
});

test("latencyClassOf derives the §4 class", () => {
  assert.equal(latencyClassOf(normalizeRoutePlan({ answerStyle: "document" })), "ARTIFACT");
  assert.equal(latencyClassOf(normalizeRoutePlan({ intent: "artifact" })), "ARTIFACT");
  assert.equal(latencyClassOf(normalizeRoutePlan({ complexity: "deep" })), "DEEP");
  assert.equal(latencyClassOf(normalizeRoutePlan({ complexity: "standard" })), "STANDARD");
  assert.equal(latencyClassOf(normalizeRoutePlan({ complexity: "fast", needsTools: false })), "FAST");
});

test("buildRouterUser carries the date and the user message", () => {
  const ctx: RequestContext = {
    requestId: "r1",
    conversationId: "c1",
    userMessage: "What is the status of MDL 3047?",
    currentDateIso: "2026-09-10",
    recentMessages: [],
  };
  const user = buildRouterUser(ctx);
  assert.match(user, /CURRENT DATE: 2026-09-10/);
  assert.match(user, /MDL 3047/);
  assert.match(user, /Return the RoutePlan JSON now\./);
});
