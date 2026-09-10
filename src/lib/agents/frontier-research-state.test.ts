import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EvidenceItem,
  RequestContext,
  ResearchRequirement,
  RoutePlan,
  ToolRunResult,
} from "./frontier-contracts.ts";
import { normalizeRoutePlan } from "./frontier-router.ts";
import { ResearchState } from "./frontier-research-state.ts";

function ctx(): RequestContext {
  return {
    requestId: "r1",
    conversationId: "c1",
    userMessage: "test",
    currentDateIso: "2026-09-10",
    recentMessages: [],
  };
}

function route(rounds: number): RoutePlan {
  return normalizeRoutePlan({ complexity: "standard", needsTools: true, maxResearchRounds: rounds });
}

function ev(partial: Partial<EvidenceItem> & { id: string }): EvidenceItem {
  return {
    sourceType: "web",
    provider: "test",
    authorityLevel: 5,
    title: partial.id,
    url: `https://example.com/${partial.id}`,
    retrievedAt: "2026-09-10T00:00:00Z",
    supports: [],
    contradicts: [],
    primarySource: false,
    currentVerified: false,
    confidence: 0.5,
    ...partial,
  };
}

function req(id: string, required = true): ResearchRequirement {
  return { id, description: id, required, evidenceIds: [], status: "missing" };
}

function ok(evidence: EvidenceItem[]): ToolRunResult {
  return { callId: "x", tool: "web.search", ok: true, evidence };
}

test("add() accumulates evidence and turns failures into limitations", () => {
  const s = new ResearchState(ctx(), route(2));
  s.add([ok([ev({ id: "a" })])]);
  s.add([{ callId: "y", tool: "courtlistener.search", ok: false, evidence: [], error: "429" }]);
  assert.equal(s.count(), 1);
  assert.deepEqual(s.limitations, ["courtlistener.search unavailable: 429"]);
});

test("dedupeAndRank collapses duplicates and orders strongest-first", () => {
  const s = new ResearchState(ctx(), route(2));
  s.add([
    ok([
      ev({ id: "web", url: "https://x.gov/1", authorityLevel: 5 }),
      ev({ id: "op", url: "https://x.gov/1", authorityLevel: 1, sourceType: "court_opinion" }),
      ev({ id: "news", url: "https://y.com/2", authorityLevel: 3, sourceType: "news" }),
    ]),
  ]);
  s.dedupeAndRank();
  const ev0 = s.evidence();
  assert.equal(ev0.length, 2); // the two x.gov/1 items collapsed
  assert.equal(ev0[0]!.authorityLevel, 1); // strongest first
});

test("updateCoverage derives requirement status from evidence links", () => {
  const s = new ResearchState(ctx(), route(2), [
    req("verified_primary"),
    req("partial_web"),
    req("conflicted"),
    req("untouched"),
  ]);
  s.add([
    ok([
      ev({ id: "p", sourceType: "court_opinion", authorityLevel: 1, supports: ["verified_primary"] }),
      ev({ id: "w", authorityLevel: 5, supports: ["partial_web"] }),
      ev({ id: "s", authorityLevel: 3, sourceType: "news", supports: ["conflicted"] }),
      ev({ id: "c", authorityLevel: 3, sourceType: "news", contradicts: ["conflicted"] }),
    ]),
  ]);
  s.updateCoverage();
  const byId = Object.fromEntries(s.requirements.map((r) => [r.id, r.status]));
  assert.equal(byId["verified_primary"], "verified");
  assert.equal(byId["partial_web"], "partial");
  assert.equal(byId["conflicted"], "conflicted");
  assert.equal(byId["untouched"], "missing");
});

test("isComplete: false without requirements, true when all required are met", () => {
  const none = new ResearchState(ctx(), route(2));
  assert.equal(none.isComplete(), false);

  const s = new ResearchState(ctx(), route(2), [req("a"), req("b", false)]);
  s.add([ok([ev({ id: "p", sourceType: "statute", authorityLevel: 1, supports: ["a"] })])]);
  s.updateCoverage();
  assert.equal(s.isComplete(), true); // only required "a" must be satisfied

  const s2 = new ResearchState(ctx(), route(2), [req("a"), req("b")]);
  s2.add([ok([ev({ id: "p", sourceType: "statute", authorityLevel: 1, supports: ["a"] })])]);
  s2.updateCoverage();
  assert.equal(s2.isComplete(), false); // "b" still missing
});
