// Unit tests for the pure subagent helpers (plan parsing, bounded pool, findings
// assembly). No AWS, no network.
//   node --experimental-strip-types --test src/lib/agents/subagent-plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, mapPoolSettled, assembleFindings, type SubagentResult } from "./subagent-plan.ts";

test("parsePlan coerces valid subquestions and carries hints/boundaries", () => {
  const input = {
    subquestions: [
      { objective: "Survey the epidemiology on talc and ovarian cancer", tools_hint: "PubMed + scientific literature", boundaries: "not the docket posture" },
      { objective: "Summarize MDL 2738 procedural posture", boundaries: "not the science" },
    ],
  };
  const specs = parsePlan(input, 5);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].objective, "Survey the epidemiology on talc and ovarian cancer");
  assert.equal(specs[0].toolsHint, "PubMed + scientific literature");
  assert.equal(specs[0].boundaries, "not the docket posture");
  assert.equal(specs[1].toolsHint, undefined);
});

test("parsePlan drops too-short objectives, dedupes, and caps at max", () => {
  const input = {
    subquestions: [
      { objective: "short" }, // < 8 chars -> dropped
      { objective: "Analyze the Daubert rulings across circuits" },
      { objective: "Analyze the Daubert rulings across circuits" }, // dup -> dropped
      { objective: "Cross-reference settlement terms with deadlines" },
      { objective: "Map the bellwether trial schedule for 2026" },
    ],
  };
  const specs = parsePlan(input, 2);
  assert.equal(specs.length, 2, "capped at max");
  assert.equal(specs[0].objective, "Analyze the Daubert rulings across circuits");
  assert.equal(specs[1].objective, "Cross-reference settlement terms with deadlines");
});

test("parsePlan returns [] for malformed input", () => {
  assert.deepEqual(parsePlan(null, 5), []);
  assert.deepEqual(parsePlan({}, 5), []);
  assert.deepEqual(parsePlan({ subquestions: "nope" }, 5), []);
  assert.deepEqual(parsePlan({ subquestions: [] }, 5), []);
});

test("mapPoolSettled preserves order, runs all, and never exceeds concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6, 7];
  const out = await mapPoolSettled(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(maxActive <= 3, `maxActive ${maxActive} should be <= 3`);
  assert.ok(maxActive >= 2, "should actually run in parallel");
});

test("mapPoolSettled tolerates tasks that resolve with an error-result", async () => {
  const out = await mapPoolSettled([1, 2, 3], 2, async (n) =>
    n === 2 ? { ok: false as const } : { ok: true as const, n },
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], { ok: false });
});

test("assembleFindings keeps only ok+non-empty results, headed by objective", () => {
  const mk = (objective: string, findings: string, ok: boolean): SubagentResult => ({
    spec: { objective },
    findings,
    refs: [],
    steps: 1,
    tokensIn: 0,
    tokensOut: 0,
    ms: 1,
    ok,
  });
  const results = [
    mk("Epidemiology", "- Sister Study cohort [S1]", true),
    mk("Docket posture", "", true), // empty -> dropped
    mk("Regulatory", "- FDA proposed rule [S2]", false), // failed -> dropped
    mk("Bellwether schedule", "- Trial set Jan 2027 [S3]", true),
  ];
  const out = assembleFindings(results);
  assert.match(out, /## Epidemiology\n- Sister Study cohort \[S1\]/);
  assert.match(out, /## Bellwether schedule\n- Trial set Jan 2027 \[S3\]/);
  assert.ok(!out.includes("Docket posture"));
  assert.ok(!out.includes("Regulatory"));
});
