import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TAIL_BUDGET_CHARS,
  TAIL_MAX_TURNS,
  TAIL_OLDER_ASSISTANT_CHARS,
  TAIL_RECENT_CHARS,
  fitTail,
  needsResolution,
  type TailTurn,
} from "./memory-budget.ts";

const FRAME =
  "[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: docket posture, bellwether schedule, and case-management orders]\n\n";

function turn(role: TailTurn["role"], len: number, seed = "x"): TailTurn {
  return { role, content: seed.repeat(len) };
}

test("fitTail keeps at most TAIL_MAX_TURNS pairs, newest last, order preserved", () => {
  const tail: TailTurn[] = [];
  for (let i = 0; i < 8; i++) {
    tail.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
  }
  const out = fitTail(tail);
  assert.equal(out.length, TAIL_MAX_TURNS * 2);
  assert.equal(out[0]!.content, `q${8 - TAIL_MAX_TURNS}`);
  assert.equal(out[out.length - 1]!.content, "a7");
});

test("fitTail trims older assistant answers harder than the newest one", () => {
  const out = fitTail([
    turn("user", 50, "u"),
    turn("assistant", 6000, "o"),
    turn("user", 50, "v"),
    turn("assistant", 6000, "n"),
  ]);
  assert.equal(out.length, 4);
  assert.ok(out[1]!.content.length <= TAIL_OLDER_ASSISTANT_CHARS);
  assert.ok(out[3]!.content.length <= TAIL_RECENT_CHARS);
  assert.ok(out[3]!.content.length > out[1]!.content.length);
});

test("fitTail drops from the front when the total budget binds", () => {
  const tail: TailTurn[] = [];
  for (let i = 0; i < TAIL_MAX_TURNS; i++) {
    tail.push(turn("user", 1100, "q"), turn("assistant", 3900, "a"));
  }
  const out = fitTail(tail);
  const total = out.reduce((n, t) => n + t.content.length, 0);
  assert.ok(total <= TAIL_BUDGET_CHARS, `total ${total} over budget`);
  // The most recent exchange always survives.
  assert.equal(out[out.length - 1]!.role, "assistant");
  assert.ok(out[out.length - 1]!.content.startsWith("a"));
  assert.ok(out.length >= 2);
});

test("fitTail ignores empty and malformed entries", () => {
  const out = fitTail([
    { role: "user", content: "   " },
    { role: "system" as unknown as "user", content: "nope" },
    { role: "assistant", content: "kept" },
  ]);
  assert.deepEqual(out, [{ role: "assistant", content: "kept" }]);
});

test("needsResolution: self-contained questions skip the rewrite", () => {
  for (const q of [
    "What is the current status of the Roundup MDL?",
    "When is the next bellwether trial in the Depo-Provera litigation?",
    "Give me the trial schedule for the Bard PowerPort litigation",
    "How has Judge Chhabria treated Daubert challenges in MDL 2741?",
    "Summarize the Camp Lejeune settlement framework announced in 2026",
    `${FRAME}Latest case-management orders in the Zantac JCCP`,
  ]) {
    assert.equal(needsResolution(q), false, q);
  }
});

test("needsResolution: referential or elliptical follow-ups keep the rewrite", () => {
  for (const q of [
    "What about Zantac?",
    "Any developments there since the last order?",
    "What did the judge rule on the motion?",
    "And the appellate posture?",
    "Compare that to the earlier ruling",
    "Who is the judge?",
    "Expand on the second point",
    "Make it a table",
    `${FRAME}How did they respond to it?`,
  ]) {
    assert.equal(needsResolution(q), true, q);
  }
});

test("needsResolution: empty input never needs a rewrite", () => {
  assert.equal(needsResolution(""), false);
  assert.equal(needsResolution(FRAME), false);
});
