import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_ANALYSIS, type DepAnalysis } from "./deposition-analysis.ts";
import { conflictSeverity, intelSummary, priorityQueue, witnessHandle } from "./dep-intel.ts";

const analysis: DepAnalysis = {
  ...EMPTY_ANALYSIS,
  witnesses: [
    { id: "w1", name: "Dr. Jane Smith, M.D.", role: "deponent", fileName: "Smith.pdf", summary: "", quote: "", cite: "" },
  ],
  contradictions: [
    {
      id: "c1",
      title: "Notice",
      summary: "Disagree on notice",
      a: { witness: "Smith", quote: "yes", cite: "2:20", fileName: "Smith.pdf" },
      b: { witness: "Jones", quote: "no", cite: "2:11", fileName: "Jones.pdf" },
      tags: ["notice"],
    },
    {
      id: "c2",
      title: "Omission",
      summary: "Not asked",
      a: { witness: "Smith", quote: "n/a", cite: "4:1", fileName: "Smith.pdf" },
      b: { witness: "Jones", quote: "n/a", cite: "4:2", fileName: "Jones.pdf" },
      tags: ["omission"],
    },
  ],
  graph: {
    nodes: [{ id: "p1", label: "Jane Smith", kind: "person" }],
    edges: [],
  },
};

test("witnessHandle drops professional suffixes", () => {
  assert.equal(witnessHandle("Dr. Jane Smith, M.D."), "Smith");
  assert.equal(witnessHandle("Robert Jones Jr."), "Jones");
  assert.equal(witnessHandle("Ann Lee, Ph.D., Esq."), "Lee");
  assert.equal(witnessHandle("Minh Do"), "Do");
  assert.equal(witnessHandle("Smith.pdf"), "Smith");
  assert.equal(witnessHandle("Jones Deposition Vol 1.PDF"), "1");
});

test("conflictSeverity treats notice conflicts as high and omissions as low", () => {
  assert.equal(conflictSeverity(analysis.contradictions[0]!), "high");
  assert.equal(conflictSeverity(analysis.contradictions[1]!), "low");
});

test("priorityQueue ranks high conflicts first", () => {
  const queue = priorityQueue(analysis);
  assert.equal(queue[0]?.id, "c1");
  assert.equal(queue.length, 2);
});

test("intelSummary counts witnesses and conflicts from the record", () => {
  const summary = intelSummary(analysis, [
    { fileName: "Smith.pdf", witness: "Jane Smith" },
    { fileName: "Jones.pdf", witness: "Robert Jones" },
  ]);
  assert.equal(summary.conflicts, 2);
  assert.equal(summary.witnesses, 2);
});
