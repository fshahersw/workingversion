import assert from "node:assert/strict";
import { test } from "node:test";

import { diversifyHits, expandNeighbors, expandQuery, looksCrossFile, parseRerankIds, roundRobinCover, samplePagesForStructure } from "./retrieve.ts";

test("diversifyHits caps pages per file then fills from the rest", () => {
  const hits = [
    { fileId: "a", n: 1 },
    { fileId: "a", n: 2 },
    { fileId: "a", n: 3 },
    { fileId: "b", n: 4 },
    { fileId: "a", n: 5 },
  ];
  assert.deepEqual(
    diversifyHits(hits, 4, 2).map((h) => h.n),
    [1, 2, 4, 3],
  );
});

test("roundRobinCover walks files instead of draining the first PDF", () => {
  const pages = [
    { fileId: "a", page: 1 },
    { fileId: "a", page: 2 },
    { fileId: "b", page: 1 },
    { fileId: "c", page: 1 },
  ];
  assert.deepEqual(
    roundRobinCover(pages, 3).map((p) => `${p.fileId}:${p.page}`),
    ["a:1", "b:1", "c:1"],
  );
});

test("samplePagesForStructure keeps every file, not only the head of the pile", () => {
  const pages = [
    ...Array.from({ length: 20 }, (_, i) => ({ fileName: "long.pdf", page: i + 1 })),
    { fileName: "short.pdf", page: 1 },
  ];
  const sampled = samplePagesForStructure(pages, 4);
  assert.ok(sampled.some((p) => p.fileName === "short.pdf"));
  assert.ok(sampled.some((p) => p.fileName === "long.pdf" && p.page === 20));
  assert.ok(sampled.filter((p) => p.fileName === "long.pdf").length <= 4);
});

test("expandNeighbors adds adjacent pages in the same file", () => {
  const catalog = [
    { fileId: "a", page: 1 },
    { fileId: "a", page: 2 },
    { fileId: "a", page: 3 },
    { fileId: "b", page: 9 },
  ];
  const expanded = expandNeighbors([{ fileId: "a", page: 2 }], catalog, 1);
  assert.deepEqual(
    expanded.map((p) => `${p.fileId}:${p.page}`),
    ["a:2", "a:1", "a:3"],
  );
});

test("looksCrossFile detects compare questions and not pinpoints", () => {
  assert.equal(looksCrossFile("compare the expert reports"), true);
  assert.equal(looksCrossFile("what did Dr. Smith conclude on causation"), false);
});

test("expandQuery adds a party name when the last name is already in the question", () => {
  const q = expandQuery("What did Smith opine?", {
    parties: ["Jane Smith", "Acme Corp"],
    issues: ["general causation"],
  });
  assert.match(q, /Jane Smith/);
});

test("parseRerankIds reads ranked fileId:page keys and ignores junk", () => {
  assert.deepEqual(parseRerankIds('{"ids":["a:12","nope","b:3"]}', 2), ["a:12", "b:3"]);
});
