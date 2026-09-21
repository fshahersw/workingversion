import assert from "node:assert/strict";
import { test } from "node:test";

import {
  THRESHOLDS,
  decideOfficeClass,
  decideResearchEffort,
  decideTopicShift,
  officeRouteQuestions,
  officeRouteState,
  researchEffortQuestions,
  topicShiftQuestions,
  topicShiftState,
} from "./typesafe-questions.ts";
import type { SystemOneResult } from "./typesafe.server.ts";

const result = (answers: SystemOneResult["answers"]): SystemOneResult => ({
  model: "jev-1.13.0",
  answers,
  usage: { inputTokens: 100, outputTokens: 10 },
  ms: 120,
});
const choiceOf = (probabilities: Record<string, number>, confidence: number) => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice" as const, choice, probabilities, confidence };
};
const noulOf = (p: number) => ({ type: "noul" as const, noul: p });

test("catalog: every question is well formed and state is bounded", () => {
  for (const [id, q] of Object.entries({ ...officeRouteQuestions(), ...researchEffortQuestions(), ...topicShiftQuestions() })) {
    assert.ok(q.instructions, id);
    if (q.type === "choice") assert.ok(Object.keys(q.criteria).length >= 2, id);
  }
  const s = officeRouteState("writer", "x".repeat(10_000)) as { request: { text: string } };
  assert.equal(s.request.text.length, 10_000, "routing must not silently discard the tail of a request");
  assert.throws(() => officeRouteState("writer", "x".repeat(12_001)), /too long/);
  const t = topicShiftState("q", Array.from({ length: 40 }, (_, i) => `f${i}`), "s".repeat(5_000)) as {
    session: { facts: string[]; summary: string };
  };
  assert.equal(t.session.facts.length, 15);
  assert.equal(t.session.summary.length, 1_200);
});

test("office: confident cheap classes route; unsure or contradicted verdicts return no opinion", () => {
  const fmt = decideOfficeClass(
    result({ task_class: choiceOf({ format: 0.9, inspect: 0.05, short_edit: 0.05, draft: 0, analyze: 0 }, 0.88), changes_document: noulOf(0.95), needs_legal_judgment: noulOf(0.02) }),
  );
  assert.equal(fmt?.taskClass, "format");
  const unsure = decideOfficeClass(
    result({ task_class: choiceOf({ format: 0.4, short_edit: 0.35, inspect: 0.25 }, 0.3), changes_document: noulOf(0.9), needs_legal_judgment: noulOf(0.05) }),
  );
  assert.equal(unsure, null, "below officeRouteMinConfidence -> caller keeps main");
  const contradicted = decideOfficeClass(
    result({ task_class: choiceOf({ inspect: 0.7, short_edit: 0.3 }, 0.6), changes_document: noulOf(0.8), needs_legal_judgment: noulOf(0.05) }),
  );
  assert.equal(contradicted, null, "inspect verdict but the request changes the document");
});

test("office: heavy classes, heavy probability mass and legal judgment always land on main-tier classes", () => {
  const draft = decideOfficeClass(result({ task_class: choiceOf({ draft: 0.55, short_edit: 0.45 }, 0.2), changes_document: noulOf(0.9), needs_legal_judgment: noulOf(0.1) }));
  assert.equal(draft?.taskClass, "draft", "low confidence is fine when the verdict is already heavy");
  const mass = decideOfficeClass(
    result({ task_class: choiceOf({ short_edit: 0.5, draft: 0.25, analyze: 0.2, format: 0.05 }, 0.6), changes_document: noulOf(0.9), needs_legal_judgment: noulOf(0.1) }),
  );
  assert.equal(mass?.taskClass, "draft");
  assert.match(mass!.reason, /heavy mass/);
  const legal = decideOfficeClass(result({ task_class: choiceOf({ inspect: 0.95, format: 0.05 }, 0.95), changes_document: noulOf(0.05), needs_legal_judgment: noulOf(0.75) }));
  assert.equal(legal?.taskClass, "analyze");
  assert.equal(decideOfficeClass(null), null);
});

test("research: conversational needs high confidence, no legal subject and no regex legal signal", () => {
  const guard = { legalSignal: false, historyTurns: 2 };
  const conv = decideResearchEffort(
    result({ effort: choiceOf({ conversational: 0.95, fast: 0.05, think: 0 }, 0.93), wants_deliverable: noulOf(0.02), legal_subject: noulOf(0.05), needs_current_info: noulOf(0.1) }),
    guard,
  );
  assert.equal(conv?.mode, "conversational");
  const vetoedByLegal = decideResearchEffort(
    result({ effort: choiceOf({ conversational: 0.95, fast: 0.05, think: 0 }, 0.93), wants_deliverable: noulOf(0.02), legal_subject: noulOf(0.6), needs_current_info: noulOf(0.1) }),
    guard,
  );
  assert.equal(vetoedByLegal?.mode, "think");
  const vetoedByRegex = decideResearchEffort(
    result({ effort: choiceOf({ conversational: 0.95, fast: 0.05, think: 0 }, 0.93), wants_deliverable: noulOf(0.02), legal_subject: noulOf(0.05), needs_current_info: noulOf(0.1) }),
    { legalSignal: true, historyTurns: 2 },
  );
  assert.equal(vetoedByRegex?.mode, "think");
  const reformatWithoutHistory = decideResearchEffort(
    result({ effort: choiceOf({ conversational: 0.85, fast: 0.15, think: 0 }, 0.82), wants_deliverable: noulOf(0.02), legal_subject: noulOf(0.05), needs_current_info: noulOf(0.1) }),
    { legalSignal: false, historyTurns: 0 },
  );
  assert.equal(reformatWithoutHistory?.mode, "think", "nothing to reformat on a first turn unless unmistakable");
});

test("research: fast needs confidence and no deliverable; think is the default", () => {
  const guard = { legalSignal: true, historyTurns: 0 };
  const fast = decideResearchEffort(
    result({ effort: choiceOf({ fast: 0.8, think: 0.2, conversational: 0 }, 0.7), wants_deliverable: noulOf(0.05), legal_subject: noulOf(0.9), needs_current_info: noulOf(0.8) }),
    guard,
  );
  assert.equal(fast?.mode, "fast");
  assert.equal(fast?.needsCurrentInfo, true);
  const deliverable = decideResearchEffort(
    result({ effort: choiceOf({ fast: 0.8, think: 0.2, conversational: 0 }, 0.7), wants_deliverable: noulOf(0.9), legal_subject: noulOf(0.9), needs_current_info: noulOf(0.2) }),
    guard,
  );
  assert.equal(deliverable?.mode, "think");
  assert.equal(deliverable?.wantsDeliverable, true);
  const lowConf = decideResearchEffort(
    result({ effort: choiceOf({ fast: 0.5, think: 0.5, conversational: 0 }, 0.3), wants_deliverable: noulOf(0.05), legal_subject: noulOf(0.9), needs_current_info: noulOf(0.2) }),
    guard,
  );
  assert.equal(lowConf?.mode, "think");
  assert.equal(decideResearchEffort(null, guard), null);
});

test("topic shift: clear yes, clear no, uncertain band falls back", () => {
  assert.equal(decideTopicShift(result({ topic_shift: noulOf(0.9) })), true);
  assert.equal(decideTopicShift(result({ topic_shift: noulOf(0.1) })), false);
  assert.equal(decideTopicShift(result({ topic_shift: noulOf(0.5) })), null);
  assert.equal(decideTopicShift(null), null);
  assert.ok(THRESHOLDS.topicShiftYes > THRESHOLDS.topicShiftNo);
});
