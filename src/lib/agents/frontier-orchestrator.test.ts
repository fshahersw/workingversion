import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceItem, RequestContext, ResearchRequirement } from "./frontier-contracts.ts";
import { normalizeRoutePlan } from "./frontier-router.ts";
import { ResearchState } from "./frontier-research-state.ts";
import {
  buildOrchestratorUser,
  normalizeOrchestratorDecision,
  parseOrchestratorDecision,
} from "./frontier-orchestrator.ts";

test("parse keeps a valid tool_batch with calls and parallel groups", () => {
  const raw = JSON.stringify({
    status: "tool_batch",
    calls: [
      { id: "a", tool: "courtlistener.search", args: { q: "x" } },
      { id: "b", tool: "web.search", args: { q: "y" } },
    ],
    parallelGroups: [["a", "b"]],
    missingElements: ["latest docket activity"],
    nextReasoningEffort: "medium",
  });
  const d = parseOrchestratorDecision(raw);
  assert.ok(d);
  assert.equal(d.status, "tool_batch");
  assert.equal(d.calls?.length, 2);
  assert.deepEqual(d.parallelGroups, [["a", "b"]]);
  assert.deepEqual(d.missingElements, ["latest docket activity"]);
  assert.equal(d.nextReasoningEffort, "medium");
});

test("empty tool_batch degrades to handoff_to_writer", () => {
  assert.equal(normalizeOrchestratorDecision({ status: "tool_batch", calls: [] }).status, "handoff_to_writer");
  assert.equal(normalizeOrchestratorDecision({ status: "tool_batch" }).status, "handoff_to_writer");
});

test("calls without a tool are dropped; missing ids are synthesized", () => {
  const d = normalizeOrchestratorDecision({
    status: "tool_batch",
    calls: [
      { id: "a", tool: "web.search", args: { q: "x" } },
      { id: "b" }, // no tool -> dropped
      { tool: "web.fetch" }, // no id -> kept with a synthesized id
    ],
  });
  assert.equal(d.calls?.length, 2);
  assert.equal(d.calls?.[0]!.id, "a");
  assert.equal(d.calls?.[1]!.tool, "web.fetch");
  assert.ok((d.calls?.[1]!.id ?? "").length > 0);
});

test("parallelGroups default to one all-calls group and drop unknown ids", () => {
  const defaulted = normalizeOrchestratorDecision({
    status: "tool_batch",
    calls: [{ id: "a", tool: "web.search", args: {} }, { id: "b", tool: "web.search", args: {} }],
  });
  assert.deepEqual(defaulted.parallelGroups, [["a", "b"]]);

  const filtered = normalizeOrchestratorDecision({
    status: "tool_batch",
    calls: [{ id: "a", tool: "web.search", args: {} }],
    parallelGroups: [["a", "ghost"]],
  });
  assert.deepEqual(filtered.parallelGroups, [["a"]]);
});

test("request_user_choice needs a valid panel, else handoff", () => {
  const withPanel = normalizeOrchestratorDecision({
    status: "request_user_choice",
    choicePanel: { id: "p", title: "Which?", selectionMode: "single", options: [] },
  });
  assert.equal(withPanel.status, "request_user_choice");
  assert.equal(withPanel.choicePanel?.id, "p");

  const noPanel = normalizeOrchestratorDecision({ status: "request_user_choice" });
  assert.equal(noPanel.status, "handoff_to_writer");
});

test("invalid status degrades to handoff_to_writer", () => {
  assert.equal(normalizeOrchestratorDecision({ status: "keep_going" }).status, "handoff_to_writer");
  assert.equal(normalizeOrchestratorDecision({}).status, "handoff_to_writer");
});

test("complete decision carries no calls", () => {
  const d = normalizeOrchestratorDecision({ status: "complete" });
  assert.equal(d.status, "complete");
  assert.equal(d.calls, undefined);
});

test("parseOrchestratorDecision returns null on non-JSON", () => {
  assert.equal(parseOrchestratorDecision("no json here"), null);
});

test("parse recovers reordered-key, prose-wrapped decisions and synthesizes call ids", () => {
  // "calls" first, "status" later, wrapped in prose — the old first-key anchor missed this.
  const raw = 'Here is the plan:\n{"calls":[{"tool":"recap_search","args":{"query":"roundup"}}],"status":"tool_batch"}';
  const d = parseOrchestratorDecision(raw);
  assert.ok(d);
  assert.equal(d.status, "tool_batch");
  assert.equal(d.calls?.length, 1);
  assert.equal(d.calls?.[0]!.tool, "recap_search");
  assert.ok((d.calls?.[0]!.id ?? "").length > 0); // id synthesized, not dropped
  assert.deepEqual(d.parallelGroups, [[d.calls![0]!.id]]);
});

test("parse reads a fenced json block regardless of key order", () => {
  const raw = '```json\n{"missingElements":["x"],"status":"tool_batch","calls":[{"tool":"web.search"}]}\n```';
  const d = parseOrchestratorDecision(raw);
  assert.ok(d);
  assert.equal(d.status, "tool_batch");
  assert.equal(d.calls?.length, 1);
});

test("normalize keeps id-less calls by synthesizing ids", () => {
  const d = normalizeOrchestratorDecision({
    status: "tool_batch",
    calls: [{ tool: "web.search", args: {} }, { tool: "recap_search", args: {} }],
  });
  assert.equal(d.calls?.length, 2);
  assert.equal(
    d.calls?.every((c) => c.id.length > 0),
    true,
  );
});

test("buildOrchestratorUser serializes request, catalog, evidence and coverage", () => {
  const ctx: RequestContext = {
    requestId: "r1",
    conversationId: "c1",
    userMessage: "What is the status of MDL 3047?",
    currentDateIso: "2026-09-10",
    recentMessages: [],
  };
  const route = normalizeRoutePlan({
    intent: "docket_status",
    complexity: "standard",
    needsTools: true,
    toolFamilies: ["courtlistener", "docketbird"],
    maxResearchRounds: 2,
  });
  const reqs: ResearchRequirement[] = [
    { id: "status", description: "current docket status", required: true, evidenceIds: [], status: "missing" },
  ];
  const s = new ResearchState(ctx, route, reqs);
  const item: EvidenceItem = {
    id: "e1",
    sourceType: "court_opinion",
    provider: "courtlistener",
    authorityLevel: 1,
    title: "Order",
    url: "https://court.gov/1",
    retrievedAt: "2026-09-10T00:00:00Z",
    eventDate: "2026-08-28",
    supports: ["status"],
    contradicts: [],
    primarySource: true,
    currentVerified: true,
    confidence: 0.9,
  };
  s.add([{ callId: "x", tool: "courtlistener.search", ok: true, evidence: [item] }]);
  s.updateCoverage();

  const user = buildOrchestratorUser(s);
  assert.match(user, /REQUEST: What is the status of MDL 3047\?/);
  assert.match(user, /TOOLS \(choose by name/);
  assert.match(user, /- courtlistener\.search/);
  assert.match(user, /\[e1\] L1\/primary court_opinion/);
  assert.match(user, /status \[verified\]/);
  assert.match(user, /RECENT TOOL RESULTS/);
  assert.match(user, /Return one OrchestratorDecision JSON now\./);
});
