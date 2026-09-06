// Unit test for the Bedrock rerank result parser. Deterministic: no AWS.
//   node --experimental-strip-types --test src/lib/kb/search.server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRerankOrder } from "./rerank-parse.ts";

test("parseRerankOrder returns the reranked index order", () => {
  const json = { results: [{ index: 2, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.5 }] };
  assert.deepEqual(parseRerankOrder(json, 3), [2, 0]);
});

test("parseRerankOrder drops out-of-range indices", () => {
  const json = { results: [{ index: 5 }, { index: 1 }] };
  assert.deepEqual(parseRerankOrder(json, 3), [1]);
});

test("parseRerankOrder falls back to identity on empty/garbage", () => {
  assert.deepEqual(parseRerankOrder({ results: [] }, 3), [0, 1, 2]);
  assert.deepEqual(parseRerankOrder(null, 2), [0, 1]);
  assert.deepEqual(parseRerankOrder({ nope: true }, 2), [0, 1]);
});
