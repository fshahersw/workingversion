// Unit tests for the saved-set RAG retrieval budget. Deterministic: pure math.
//   node --experimental-strip-types --test src/lib/kb/ask-budget.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunksForDoc,
  planRetrieval,
  RAG_GLOBAL_CHUNK_CAP,
  RAG_MAX_CHUNKS_PER_DOC,
  RAG_MIN_CHUNKS_PER_DOC,
  type RagRetrievalDoc,
} from "./ask-budget.ts";

const doc = (over: Partial<RagRetrievalDoc>): RagRetrievalDoc => ({
  docId: over.docId ?? "d1",
  fileName: over.fileName ?? "brief.pdf",
  pageCount: over.pageCount ?? 20,
  ...(over.chunkCount !== undefined ? { chunkCount: over.chunkCount } : {}),
});

test("chunksForDoc: floor holds for small documents", () => {
  assert.equal(chunksForDoc(doc({ pageCount: 5, chunkCount: 50 })), RAG_MIN_CHUNKS_PER_DOC);
  assert.equal(chunksForDoc(doc({ pageCount: 0, chunkCount: 40 })), RAG_MIN_CHUNKS_PER_DOC);
});

test("chunksForDoc: scales up with page count", () => {
  // 12 + floor(30/15)=2 -> 14
  assert.equal(chunksForDoc(doc({ pageCount: 30, chunkCount: 100 })), 14);
  // 12 + floor(150/15)=10 -> 22
  assert.equal(chunksForDoc(doc({ pageCount: 150, chunkCount: 100 })), 22);
});

test("chunksForDoc: clamps to the per-doc ceiling", () => {
  assert.equal(chunksForDoc(doc({ pageCount: 5000, chunkCount: 9000 })), RAG_MAX_CHUNKS_PER_DOC);
});

test("chunksForDoc: never exceeds the chunks that exist", () => {
  assert.equal(chunksForDoc(doc({ pageCount: 300, chunkCount: 4 })), 4);
  assert.equal(chunksForDoc(doc({ pageCount: 300, chunkCount: 1 })), 1);
});

test("chunksForDoc: tabular types get a modest multiplier", () => {
  // ceil((12 + floor(30/15)=2) * 1.25) = ceil(17.5) = 18
  assert.equal(chunksForDoc(doc({ fileName: "data.xlsx", pageCount: 30, chunkCount: 100 })), 18);
  assert.equal(chunksForDoc(doc({ fileName: "rows.csv", pageCount: 30, chunkCount: 100 })), 18);
  // pdf of the same size stays at 14
  assert.equal(chunksForDoc(doc({ fileName: "same.pdf", pageCount: 30, chunkCount: 100 })), 14);
});

test("planRetrieval: under the cap leaves each doc at its full request", () => {
  const docs = [
    doc({ docId: "a", pageCount: 20, chunkCount: 100 }),
    doc({ docId: "b", pageCount: 20, chunkCount: 100 }),
    doc({ docId: "c", pageCount: 20, chunkCount: 100 }),
  ];
  const plan = planRetrieval(docs);
  assert.equal(plan.length, 3);
  for (const p of plan) assert.ok(p.k >= RAG_MIN_CHUNKS_PER_DOC);
  assert.ok(plan.reduce((s, p) => s + p.k, 0) <= RAG_GLOBAL_CHUNK_CAP);
});

test("planRetrieval: many docs shrink proportionally but never exceed the cap", () => {
  const docs = Array.from({ length: 20 }, (_, i) =>
    doc({ docId: `d${i}`, pageCount: 20, chunkCount: 100 }),
  );
  const plan = planRetrieval(docs);
  const total = plan.reduce((s, p) => s + p.k, 0);
  assert.ok(total <= RAG_GLOBAL_CHUNK_CAP, `total ${total} <= cap`);
  for (const p of plan) assert.ok(p.k >= 1, "every doc keeps at least one chunk");
});

test("planRetrieval: respects a custom cap and stays deterministic", () => {
  const docs = Array.from({ length: 10 }, (_, i) =>
    doc({ docId: `d${i}`, pageCount: 60, chunkCount: 200 }),
  );
  const a = planRetrieval(docs, 50);
  const b = planRetrieval(docs, 50);
  assert.deepEqual(a, b);
  assert.ok(a.reduce((s, p) => s + p.k, 0) <= 50);
});
