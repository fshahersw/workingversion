import assert from "node:assert/strict";
import { test } from "node:test";

import { suggestQuestions } from "./suggest-questions.ts";

test("focus becomes the first suggested question", () => {
  const qs = suggestQuestions(null, "Causation experts and Daubert exposure");
  assert.equal(qs[0], "Summarize this set with a focus on Causation experts and Daubert exposure?");
  assert.ok(!qs.includes("Causation experts and Daubert exposure?"));
  assert.ok(qs.length <= 5);
});

test("structure issues appear before generic defaults", () => {
  const qs = suggestQuestions(
    {
      inventory: [],
      parties: ["Reyes"],
      dates: [],
      issues: ["general causation", "statute of limitations"],
    },
    null,
  );
  assert.ok(qs.some((q) => /general causation/i.test(q)));
  assert.ok(qs.some((q) => /statute of limitations/i.test(q)));
  assert.ok(qs.some((q) => /Reyes/i.test(q)));
});

test("dedupes near-identical prompts and caps at limit", () => {
  const qs = suggestQuestions(
    { inventory: [], parties: [], dates: [], issues: ["deadlines", "deadlines"] },
    "Every deadline and hearing date",
    3,
  );
  assert.equal(qs.length, 3);
  assert.equal(new Set(qs.map((q) => q.toLowerCase())).size, 3);
});
