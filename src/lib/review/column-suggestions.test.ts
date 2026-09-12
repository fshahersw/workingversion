import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleReviewDocuments, validateColumnSuggestions } from "./column-suggestions.ts";
test("column sampling represents every file and discloses its sampled coverage", () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    id: `d${i}`,
    name: `Source ${i}`,
    pageCount: 100,
  }));
  const pages = files.flatMap((f) =>
    [1, 50, 100].map((page) => ({
      fileId: f.id,
      fileName: f.name,
      page,
      ocr: false,
      text: "Evidence ".repeat(1000),
    })),
  );
  const sample = sampleReviewDocuments(files, pages);
  assert.equal(sample.files, 60);
  assert.equal(sample.sampledPages, 180);
  assert.equal(sample.totalPages, 6000);
  assert.ok(sample.context.includes("Source 59"));
  assert.ok(sample.context.length <= 64000);
});
test("column generation does not quietly ignore a document with missing text", () => {
  assert.throws(
    () => sampleReviewDocuments([{ id: "a", name: "Missing", pageCount: 5 }], []),
    /unavailable/,
  );
});
test("column proposals reject unknown types, invalid choices and duplicate existing names", () => {
  const base = {
    name: "Responsible party",
    kind: "text",
    question: "Who received the warning? Quote the supporting evidence.",
    options: [],
    reason: "Identify notice",
  };
  const result = validateColumnSuggestions(
    {
      columns: [
        { ...base, name: "Existing" },
        { ...base, kind: "code" },
        { ...base, kind: "select", options: [] },
        base,
        base,
      ],
    },
    ["existing"],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, "text");
});
