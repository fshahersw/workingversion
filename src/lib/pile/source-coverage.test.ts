import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceCoverage } from "./source-coverage.ts";
import type { PileFileHits } from "./types.ts";

const groups: PileFileHits[] = [
  {
    fileId: "a",
    fileName: "incident-report.pdf",
    pageCount: 10,
    matched: true,
    topScore: 3,
    hits: [
      { fileId: "a", fileName: "incident-report.pdf", page: 2, score: 3, snippet: "one" },
      { fileId: "a", fileName: "incident-report.pdf", page: 4, score: 2, snippet: "two" },
    ],
  },
  {
    fileId: "b",
    fileName: "medical-record.pdf",
    pageCount: 12,
    matched: false,
    topScore: 0,
    hits: [],
  },
];

test("source coverage reports every considered file and unmatched names", () => {
  assert.deepEqual(sourceCoverage(groups), {
    totalFiles: 2,
    matchedFiles: 1,
    unmatchedFiles: ["medical-record.pdf"],
    passages: 2,
  });
});
