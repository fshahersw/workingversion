import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCitations, factCheck } from "./fact-check.ts";
import type { Source } from "./chat-types.ts";

const src = (ref: string, content: string): Source => ({
  ref,
  citation: `Source ${ref}`,
  authority: "web",
  source_type: "news",
  content,
});

test("a specific inside the trimmed excerpt verifies; one outside it does not", () => {
  const answer = "The order issued Mar 4, 2026 in MDL 3140 set a $1.2 billion fund.";
  const sources = [src("S1", "On Mar 4, 2026 the court in MDL 3140 entered the order.")];
  const claims = factCheck(answer, sources);
  const byValue = Object.fromEntries(claims.map((c) => [c.value, c.verified]));
  assert.equal(byValue["Mar 4, 2026"], true);
  assert.equal(byValue["MDL 3140"], true);
  assert.equal(byValue["$1.2 billion"], false);
});

test("the untrimmed verification shadow rescues a specific the excerpt cut off", () => {
  const answer = "The order issued Mar 4, 2026 in MDL 3140 set a $1.2 billion fund.";
  const sources = [src("S1", "On Mar 4, 2026 the court in MDL 3140 entered the order.")];
  const fullTexts = ["... entered the order. The settlement establishes a $1.2 billion fund for claimants ..."];
  const claims = factCheck(answer, sources, fullTexts);
  const amount = claims.find((c) => c.kind === "amount");
  assert.ok(amount);
  assert.equal(amount.verified, true);
});

test("citation integrity flags orphan refs and lists unused sources", () => {
  const answer = "Filed in 2026 [S1]. A later order [S3] followed.";
  const r = checkCitations(answer, [src("S1", "a"), src("S2", "b")]);
  assert.deepEqual(r.cited.sort(), ["S1", "S3"]);
  assert.deepEqual(r.orphans, ["S3"]);
  assert.deepEqual(r.unused, ["S2"]);
});
