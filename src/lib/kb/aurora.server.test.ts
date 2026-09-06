// Unit test for the KB Aurora Data API seam. Covers the pure helpers and the
// unconfigured guard. Deterministic: no AWS, no network, no env.
//   node --experimental-strip-types --test src/lib/kb/aurora.server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  param,
  vectorLiteral,
  kbConfigured,
  hybridSearch,
  fetchChunks,
  insertDocument,
  insertChunks,
  withPrincipal,
  deleteWorkspaceDocuments,
} from "./aurora.server.ts";

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

test("kbConfigured evaluates the supplied environment lazily", () => {
  assert.equal(kbConfigured({ NODE_ENV: "development" }), false);
  assert.equal(
    kbConfigured({
      NODE_ENV: "development",
      AWS_REGION: "test-region",
      KB_CLUSTER_ARN: "test-cluster-arn",
      KB_SECRET_ARN: "test-secret-arn",
      KB_DATABASE: "test-database",
    }),
    true,
  );
  assert.equal(
    kbConfigured({
      NODE_ENV: "development",
      KB_CLUSTER_ARN: "test-cluster-arn",
    }),
    false,
  );
});

test("data calls reject when unconfigured", async () => {
  await assert.rejects(
    () => hybridSearch({ sub: "u1", workspaceId: "w1", surface: "workingset", query: "q", embedding: [0, 0] }),
    /not configured/,
  );
  await assert.rejects(() => withPrincipal("u1", async () => 1), /not configured/);
  await assert.rejects(
    () => fetchChunks("u1", "w1", "workingset", [1, 2]),
    /not configured/,
  );
});

test("fetchChunks short-circuits on empty ids", async () => {
  // Returns before requireConfig, so it must not throw even unconfigured.
  assert.deepEqual(await fetchChunks("u1", "w1", "workingset", []), []);
});

test("write calls reject when unconfigured", async () => {
  await assert.rejects(
    () => insertDocument("u1", { workspaceId: "w1", surface: "workingset", fileName: "f.pdf" }),
    /not configured/,
  );
  await assert.rejects(
    () =>
      insertChunks("u1", "d1", "w1", "workingset", [
        { chunkIndex: 0, pageStart: 1, pageEnd: 1, kind: "para", content: "x", embedding: [1] },
      ]),
    /not configured/,
  );
  await assert.rejects(
    () => deleteWorkspaceDocuments("u1", "w1"),
    /not configured/,
  );
});

test("insertChunks short-circuits on empty rows", async () => {
  await insertChunks("u1", "d1", "w1", "workingset", []); // no throw even unconfigured
});

test("workspace deletion is owner-filtered and runs under the RLS principal", () => {
  const source = readFileSync(new URL("./aurora.server.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function deleteWorkspaceDocuments");
  const end = source.indexOf("\nexport type KbDocumentRow", start);
  assert.notEqual(start, -1);
  const block = source.slice(start, end);
  assert.match(block, /DELETE FROM kb\.documents/);
  assert.match(block, /owner_sub = :owner/);
  assert.match(block, /workspace_id = CAST\(:workspace AS uuid\)/);
  assert.match(block, /withPrincipal\(sub/);
});
