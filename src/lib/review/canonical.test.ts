import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalKey, harmonizeValues, matchOption } from "./canonical.ts";
import { fusePageRanks, withNeighbours } from "./retrieval-fusion.ts";

test("canonical key ignores case, punctuation, whitespace and diacritics", () => {
  assert.equal(canonicalKey("Pfizer, Inc."), "pfizer inc");
  assert.equal(canonicalKey("  pfizer   INC "), "pfizer inc");
  assert.equal(canonicalKey("Société Générale"), "societe generale");
  assert.equal(canonicalKey("“Smith” v. Jones"), "smith v jones");
});

test("options match exactly, then by normalization, then conservatively fuzzy", () => {
  const options = ["Privileged", "Not privileged", "Needs review"];
  assert.deepEqual(matchOption("Privileged", options), { option: "Privileged", method: "exact" });
  assert.deepEqual(matchOption("privileged.", options), {
    option: "Privileged",
    method: "normalized",
  });
  assert.deepEqual(matchOption("not privileged (work product)", options), {
    option: "Not privileged",
    method: "fuzzy",
  });
  assert.deepEqual(matchOption("Responsive", options), { option: null, method: "none" });
});

test("an answer that could be two options is ambiguous, not guessed", () => {
  const options = ["Pfizer Inc. (US)", "Pfizer Inc. (EU)", "Merck"];
  assert.deepEqual(matchOption("Pfizer Inc", options), { option: null, method: "ambiguous" });
  // Below the 80% overlap bar and not a containment: no match rather than a guess.
  const conditions = ["Yes, with conditions", "Yes, without conditions"];
  assert.deepEqual(matchOption("yes conditions", conditions), { option: null, method: "none" });
});

test("harmonization collapses spelling variants to the dominant form", () => {
  const values = ["Pfizer Inc.", "pfizer inc", "Pfizer, Inc", "Pfizer Inc.", "Merck", "Pfizer"];
  const { changes, before, after } = harmonizeValues(values);
  assert.equal(before, 5);
  assert.equal(after, 3);
  assert.equal(changes.get("pfizer inc"), "Pfizer Inc.");
  assert.equal(changes.get("Pfizer, Inc"), "Pfizer Inc.");
  assert.equal(changes.has("Pfizer"), false, "a shorter name is a different value");
  assert.equal(changes.has("Merck"), false);
});

test("harmonization ties prefer the fullest spelling, then first seen", () => {
  const tie = harmonizeValues(["acme corp", "Acme Corp."]);
  assert.equal(tie.changes.get("acme corp"), "Acme Corp.");
  const firstSeen = harmonizeValues(["Acme Corp", "Acme corp"]);
  assert.equal(firstSeen.changes.get("Acme corp"), "Acme Corp");
});

test("rank fusion keeps pages either ranker is confident about, in document order", () => {
  // Page 30 is the semantic ranker's top pick and beats the lexical #2.
  assert.deepEqual(fusePageRanks([4, 5, 12], [30, 4, 12], 3), [4, 12, 30]);
  // Equal evidence (one ranker each, same rank) breaks toward the lexical ranker.
  assert.deepEqual(fusePageRanks([4, 5, 12], [12, 30, 4], 3), [4, 5, 12]);
  assert.deepEqual(fusePageRanks([7], [], 4), [7]);
  assert.deepEqual(fusePageRanks([], [9, 2], 4), [2, 9]);
});

test("neighbour expansion never drops a chosen page or exceeds the cap", () => {
  assert.deepEqual(withNeighbours([5], 10, 3), [4, 5, 6]);
  assert.deepEqual(withNeighbours([1, 10], 10, 3), [1, 2, 10]);
  assert.deepEqual(withNeighbours([3, 4], 4, 8), [2, 3, 4]);
});
