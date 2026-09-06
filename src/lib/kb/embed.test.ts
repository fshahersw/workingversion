// Unit tests for KB embed step. Deterministic: injected fake embedder, no AWS.
//   node --experimental-strip-types --test src/lib/kb/embed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { contextualize, embedChunks } from "./embed.ts";
import type { KbChunkInput } from "./chunk.ts";

const chunk = (over: Partial<KbChunkInput>): KbChunkInput => ({
  chunkIndex: 0,
  pageStart: 1,
  pageEnd: 1,
  kind: "para",
  content: "body",
  headingPath: "",
  tokenCount: 1,
  ...over,
});

test("contextualize builds file — heading — page", () => {
  assert.equal(
    contextualize("depo.pdf", chunk({ headingPath: "Direct Examination", pageStart: 12 })),
    "depo.pdf — Direct Examination — p. 12",
  );
  assert.equal(contextualize("n.txt", chunk({ headingPath: "", pageStart: 1 })), "n.txt — p. 1");
});

test("embedChunks embeds context+content, preserves order, keeps content verbatim", async () => {
  const seen: string[] = [];
  const rows = await embedChunks(
    "f.pdf",
    [
      chunk({ chunkIndex: 0, content: "first", pageStart: 1 }),
      chunk({ chunkIndex: 1, content: "second", pageStart: 2, headingPath: "H" }),
    ],
    {
      concurrency: 1,
      embed: async (text) => {
        seen.push(text);
        return [text.length, 0, 0];
      },
    },
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.chunkIndex),
    [0, 1],
  );
  // content stays verbatim; context is separate; embed input is context + content
  assert.equal(rows[0]!.content, "first");
  assert.equal(rows[1]!.context, "f.pdf — H — p. 2");
  assert.ok(seen[1]!.startsWith("f.pdf — H — p. 2\n\nsecond"));
  assert.ok(Array.isArray(rows[0]!.embedding));
});

test("embedChunks retries a transient embed failure", async () => {
  let calls = 0;
  const rows = await embedChunks("f.pdf", [chunk({})], {
    concurrency: 1,
    embed: async () => {
      calls++;
      if (calls === 1) throw new Error("429");
      return [1];
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(rows[0]!.embedding, [1]);
});
