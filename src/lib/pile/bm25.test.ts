import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, pruneQueryTerms, search, tokenize } from "./bm25.ts";

test("tokenize lowercases and drops punctuation", () => {
  assert.deepEqual(tokenize("Daubert, Rule 702."), ["daubert", "rule", "702"]);
});

test("tokenize keeps docket-style tokens intact", () => {
  const toks = tokenize("See 2:24-cv-00183 on PACER");
  assert.ok(toks.includes("2:24-cv-00183"));
  assert.ok(toks.includes("pacer"));
});

test("search ranks the page that contains the query terms", () => {
  const index = buildIndex([
    { id: "a:1", text: "The court denied the motion to dismiss." },
    { id: "b:12", text: "Plaintiffs' Daubert challenge to the epidemiology expert." },
    { id: "c:3", text: "Certificate of service on all parties." },
  ]);
  const hits = search(index, "Daubert epidemiology", 3);
  assert.equal(hits[0]?.id, "b:12");
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
});

test("unknown query returns no hits", () => {
  const index = buildIndex([{ id: "a:1", text: "complaint filed in the southern district" }]);
  assert.deepEqual(search(index, "zyzzx-not-a-word"), []);
});

test("near-universal query terms are pruned but selective ones survive", () => {
  const docs = Array.from({ length: 20 }, (_, i) => ({
    id: `a:${i + 1}`,
    text: "the court and the parties and the record",
  }));
  docs[7] = { id: "a:8", text: "the court and the parties and the record and Daubert" };
  const index = buildIndex(docs);
  assert.deepEqual(pruneQueryTerms(index, tokenize("the and Daubert")), ["daubert"]);
  const hits = search(index, "the and Daubert", 3);
  assert.equal(hits[0]?.id, "a:8");
});

test("pruning never drops negations or docket numbers", () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    id: `a:${i + 1}`,
    text: "the defendant shall not file 2:24-cv-00183 and the exhibit",
  }));
  const index = buildIndex(docs);
  const kept = pruneQueryTerms(index, tokenize("not 2:24-cv-00183 the"));
  assert.ok(kept.includes("not"));
  assert.ok(kept.includes("2:24-cv-00183"));
  assert.ok(!kept.includes("the"));
});

test("an all-common-terms query still returns results", () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    id: `a:${i + 1}`,
    text: "the court and the parties",
  }));
  const index = buildIndex(docs);
  assert.ok(search(index, "the court", 3).length > 0);
});
