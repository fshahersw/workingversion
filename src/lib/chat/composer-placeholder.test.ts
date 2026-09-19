import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_PLACEHOLDER, composerPlaceholder, topicFromQuestion } from "./composer-placeholder.ts";

const NOW = new Date("2026-09-19T20:00:00Z");

test("topicFromQuestion: proper-noun anchors and MDL numbers, never sentence openers or bare roles", () => {
  assert.equal(topicFromQuestion("What is the status of the Zantac MDL?"), "Zantac MDL");
  assert.equal(topicFromQuestion("[Seeger Weiss LLP — research]\n\nCompare the Daubert rulings in Roundup"), "Daubert");
  assert.equal(topicFromQuestion("Has Judge Chhabria ruled on the motion?"), "Judge Chhabria");
  assert.equal(topicFromQuestion("Give me the latest on MDL 2738 please"), "MDL 2738");
  assert.equal(topicFromQuestion("What did the judge say?"), null);
  assert.equal(topicFromQuestion("thanks"), null);
  assert.equal(topicFromQuestion(""), null);
  assert.equal(topicFromQuestion("Explain the AT&T fee-award developments"), "AT&T");
});

test("no context: rotates through the generic set and includes the classic prompt", () => {
  const seen = new Set<string>();
  let prev: string | null = null;
  for (let turn = 0; turn < 12; turn++) {
    const p = composerPlaceholder({ turnCount: turn, previous: prev, now: NOW });
    assert.ok(p.length > 8 && p.length < 90);
    assert.notEqual(p, prev, "never the same twice in a row");
    seen.add(p);
    prev = p;
  }
  assert.ok(seen.size >= 5);
  assert.ok(composerPlaceholder({ turnCount: 0, now: NOW }) !== "" );
  assert.ok([...seen].some((p) => p === DEFAULT_PLACEHOLDER) || seen.size >= 5);
});

test("with a matter but no topical question: nudges about the matter by LABEL only", () => {
  const p = composerPlaceholder({ matterLabel: "In re Roundup (MDL 2741)", lastQuestion: "thanks, that helps", turnCount: 3, now: NOW });
  assert.match(p, /Roundup/);
  assert.ok(!/thanks/i.test(p), "raw question text never leaks into the placeholder");
});

test("with a topical question: references the subject, not the whole question", () => {
  const p = composerPlaceholder({
    matterLabel: "In re Roundup (MDL 2741)",
    lastQuestion: "What did the Third Circuit hold in Fosamax on preemption of failure-to-warn claims?",
    turnCount: 2,
    now: NOW,
  });
  assert.match(p, /Third Circuit|Fosamax/);
  assert.ok(!/preemption of failure-to-warn/.test(p));
});

test("the rolling set is stable within a two-day bucket and changes across buckets", () => {
  const a = composerPlaceholder({ turnCount: 1, now: NOW });
  const b = composerPlaceholder({ turnCount: 1, now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(a, b, "same bucket, same turn -> same nudge");
  const later = Array.from({ length: 7 }, (_, t) => composerPlaceholder({ turnCount: t, now: new Date(NOW.getTime() + 6 * 86_400_000) }));
  const nowSet = Array.from({ length: 7 }, (_, t) => composerPlaceholder({ turnCount: t, now: NOW }));
  assert.notDeepEqual(later, nowSet, "a later bucket rotates differently");
});
