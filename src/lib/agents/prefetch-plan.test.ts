import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrefetchPlan } from "./prefetch-plan.ts";

const FRAME =
  "[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: Prioritize the live docket: MDL number, transferee judge, most recent CMO/PTO, and current bellwether schedule.]\n\n";

test("a conversational turn gets no sweep, framed or not", () => {
  assert.equal(buildPrefetchPlan("hello"), null);
  assert.equal(buildPrefetchPlan(`${FRAME}thanks, that helps`), null);
});

test("a bare-topic question with fewer than two distinctive terms gets no sweep", () => {
  assert.equal(buildPrefetchPlan("litigation"), null);
});

test("a docket question sweeps the MDL / news / state-court sets on its distinctive terms", () => {
  const plan = buildPrefetchPlan(
    `${FRAME}What is the current bellwether schedule in the Depo-Provera MDL 3140 as of this month?`,
  );
  assert.ok(plan);
  assert.ok(plan.categories.includes("mdl_class_action"));
  assert.ok(plan.categories.includes("legal_news"));
  // Distinctive terms survive; generic filler ("schedule", "current") does not.
  assert.match(plan.query, /depo/i);
  assert.match(plan.query, /3140/);
  assert.doesNotMatch(plan.query, /\bschedule\b|\bcurrent\b/i);
  assert.ok(plan.query.split(" ").length <= 4);
});

test("a causation question sweeps the science set", () => {
  const plan = buildPrefetchPlan("Is there epidemiology linking Ozempic to NAION? Daubert posture?");
  assert.ok(plan);
  assert.ok(plan.categories.includes("scientific_medical"));
});

test("the relaxed variant differs from the primary only when it would widen recall", () => {
  const plan = buildPrefetchPlan("Roundup MDL 2741 Rule 702 ruling 2026 Chhabria");
  assert.ok(plan);
  for (const q of plan.queries) {
    assert.notEqual(q.toLowerCase(), plan.query.toLowerCase());
    assert.doesNotMatch(q, /\b20\d{2}\b/);
  }
});
