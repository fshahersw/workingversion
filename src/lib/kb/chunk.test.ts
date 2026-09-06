// Unit tests for KB chunking. Deterministic: no AWS, no model calls.
//   node --experimental-strip-types --test src/lib/kb/chunk.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkDocument } from "./chunk.ts";
import type { CanonicalDoc } from "./canonical.ts";

const doc = (pages: CanonicalDoc["pages"]): CanonicalDoc => ({
  fileName: "f.pdf",
  pageCount: pages.length,
  pages,
});

test("groups short prose on one page into a single page-anchored chunk", () => {
  const c = chunkDocument(
    doc([
      {
        pageNo: 1,
        blocks: [
          { kind: "para", text: "Alpha." },
          { kind: "para", text: "Beta." },
          { kind: "para", text: "Gamma." },
        ],
      },
    ]),
  );
  assert.equal(c.length, 1);
  assert.equal(c[0]!.kind, "para");
  assert.equal(c[0]!.pageStart, 1);
  assert.equal(c[0]!.pageEnd, 1);
  assert.ok(c[0]!.content.includes("Alpha") && c[0]!.content.includes("Gamma"));
});

test("heading is a boundary and sets the heading path", () => {
  const c = chunkDocument(
    doc([
      {
        pageNo: 1,
        blocks: [
          { kind: "para", text: "Intro." },
          { kind: "heading", text: "Section A", level: 1 },
          { kind: "para", text: "Body A." },
        ],
      },
    ]),
  );
  assert.equal(c.length, 2);
  assert.equal(c[0]!.headingPath, "");
  assert.equal(c[1]!.headingPath, "Section A");
  assert.ok(c[1]!.content.includes("Body A"));
});

test("prose never spans pages", () => {
  const c = chunkDocument(
    doc([
      { pageNo: 1, blocks: [{ kind: "para", text: "Page one." }] },
      { pageNo: 2, blocks: [{ kind: "para", text: "Page two." }] },
    ]),
  );
  assert.equal(c.length, 2);
  assert.deepEqual(
    c.map((x) => x.pageStart),
    [1, 2],
  );
});

test("large table splits into row-groups that each repeat the header", () => {
  const rows = Array.from({ length: 20 }, (_, i) => [`r${i}`, `v${i}`]);
  const c = chunkDocument(
    doc([{ pageNo: 3, blocks: [{ kind: "table", text: "", table: { header: ["A", "B"], rows } }] }]),
    { tableGroupChars: 60 },
  );
  assert.ok(c.length > 1, "expected multiple row-group chunks");
  for (const chunk of c) {
    assert.equal(chunk.kind, "table");
    assert.equal(chunk.pageStart, 3);
    assert.ok(chunk.content.includes("| A | B |"), "each group repeats the header");
  }
});

test("long prose splits with overlap carried into the next chunk", () => {
  const c = chunkDocument(
    doc([
      {
        pageNo: 1,
        blocks: [
          { kind: "para", text: "aaaa bbbb" },
          { kind: "para", text: "cccc dddd" },
          { kind: "para", text: "eeee ffff" },
        ],
      },
    ]),
    { targetChars: 20, overlapChars: 8 },
  );
  assert.equal(c.length, 2);
  assert.ok(c[0]!.content.includes("aaaa"));
  assert.ok(c[1]!.content.startsWith("dddd"), `overlap not carried: ${c[1]!.content}`);
});

test("maxChunkChars hard-splits an oversized unit", () => {
  const c = chunkDocument(
    doc([{ pageNo: 1, blocks: [{ kind: "para", text: "x".repeat(100) }] }]),
    { maxChunkChars: 40 },
  );
  assert.equal(c.length, 3);
  for (const chunk of c) assert.ok(chunk.content.length <= 40);
});
