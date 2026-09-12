import assert from "node:assert/strict";
import { test } from "node:test";
import { combineCellSections, scanReviewCell } from "./full-scan.ts";
import type { CellAnswer, CellRequest } from "./types.ts";
const answer = (value: string | string[]): CellAnswer => ({
  value,
  display: String(value),
  status: "answered",
  confidence: "high",
  citations: [{ page: 1, quote: "The source says Alice" }],
  rationale: "Named in testimony",
});
test("full review merges list values without losing later-window entries", () => {
  const value = combineCellSections(
    "list",
    [answer(["Alice"]), answer(["Bob", "Alice"])],
    true,
    "complete",
  );
  assert.deepEqual(value.value, ["Alice", "Bob"]);
  assert.equal(value.status, "answered");
});
test("conflicting scalar answers are never averaged or silently picked", () => {
  const value = combineCellSections(
    "date",
    [answer("2025-01-01"), answer("2026-02-02")],
    true,
    "complete",
  );
  assert.equal(value.status, "needs_review");
  assert.equal(value.value, null);
  assert.match(value.display, /2025.*2026/);
});
test("empty context never establishes absence; partial positives retain uncertainty", () => {
  assert.equal(combineCellSections("text", [], false, "missing").status, "needs_review");
  const found = combineCellSections("text", [answer("Alice")], false, "missing");
  assert.equal(found.status, "needs_review");
  assert.equal(found.value, "Alice");
});
test("one verified section cannot hide another uncertain section", () => {
  const value = combineCellSections(
    "text",
    [answer("Alice"), { ...answer("Alice"), status: "needs_review" }],
    true,
    "complete",
  );
  assert.equal(value.status, "needs_review");
  assert.equal(value.confidence, "low");
});
test("full cell scan retries missing windows while preserving successful answers", async () => {
  const cache = new Map<string, CellAnswer>();
  let calls = 0;
  let fail = true;
  const input: CellRequest = {
    columnName: "Names",
    question: "List all names",
    kind: "list",
    options: [],
    fileName: "deposition.txt",
    pages: [
      { page: 1, text: "The source says Alice " + "x".repeat(31978) },
      { page: 2, text: "The source says Bob" },
    ],
  };
  const opts = {
    input,
    totalPages: 2,
    fileId: "a",
    signal: new AbortController().signal,
    cache,
    request: async (req: CellRequest) => {
      calls++;
      const last = req.pages[0]!.page === 2;
      if (last && fail) throw new Error("Reader timeout");
      return {
        ...answer([last ? "Bob" : "Alice"]),
        citations: [{ page: last ? 2 : 1, quote: `The source says ${last ? "Bob" : "Alice"}` }],
      };
    },
  };
  const first = await scanReviewCell(opts);
  assert.equal(first.answer.status, "error");
  assert.deepEqual(first.pagesSearched, [1]);
  fail = false;
  const second = await scanReviewCell(opts);
  assert.deepEqual(second.answer.value, ["Alice", "Bob"]);
  assert.equal(second.answer.status, "answered");
  assert.equal(calls, 3);
});
test("unsupported citation in a cell is flagged even if model says high confidence", async () => {
  const result = await scanReviewCell({
    input: {
      columnName: "Name",
      question: "Name the witness",
      kind: "text",
      options: [],
      fileName: "a",
      pages: [{ page: 1, text: "Bob attended." }],
    },
    totalPages: 1,
    fileId: "a",
    signal: new AbortController().signal,
    cache: new Map(),
    request: async () => answer("Alice"),
  });
  assert.equal(result.answer.status, "needs_review");
  assert.equal(result.answer.citations.length, 0);
});
