// Unit test for the KB Aurora Data API seam. Covers the pure helpers and the
// unconfigured guard. Deterministic: no AWS, no network, no env.
//   node --experimental-strip-types --test src/lib/kb/aurora.server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { param, vectorLiteral, kbConfigured, hybridSearch, withPrincipal } from "./aurora.server.ts";

test("param infers the Data API field type", () => {
  assert.deepEqual(param("s", "hi"), { name: "s", value: { stringValue: "hi" } });
  assert.deepEqual(param("n", 42), { name: "n", value: { longValue: 42 } });
  assert.deepEqual(param("f", 1.5), { name: "f", value: { doubleValue: 1.5 } });
  assert.deepEqual(param("b", true), { name: "b", value: { booleanValue: true } });
  assert.deepEqual(param("z", null), { name: "z", value: { isNull: true } });
});

test("vectorLiteral formats a pgvector literal", () => {
  assert.equal(vectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
  assert.equal(vectorLiteral([]), "[]");
});

test("kbConfigured is false without env", () => {
  // No KB_* env in the test runner.
  assert.equal(kbConfigured(), false);
});

test("data calls reject when unconfigured", async () => {
  await assert.rejects(
    () => hybridSearch({ sub: "u1", workspaceId: "w1", surface: "workingset", query: "q", embedding: [0, 0] }),
    /not configured/,
  );
  await assert.rejects(() => withPrincipal("u1", async () => 1), /not configured/);
});
