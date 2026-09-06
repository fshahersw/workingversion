// Unit tests for KB converters. Deterministic: no AWS, no byte parsing.
//   node --experimental-strip-types --test src/lib/kb/convert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  markdownToBlocks,
  bdaToCanonical,
  sheetsToCanonical,
  textToCanonical,
  pagesToCanonical,
} from "./convert.ts";

const META = { fileName: "f.pdf" };

test("markdownToBlocks parses headings, tables, lists, paragraphs", () => {
  const md = [
    "# Title",
    "",
    "Some intro paragraph.",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "| 3 | 4 |",
    "",
    "- first",
    "- second",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "para", "table", "list"]);
  const table = blocks.find((b) => b.kind === "table")!;
  assert.deepEqual(table.table!.header, ["A", "B"]);
  assert.deepEqual(table.table!.rows, [
    ["1", "2"],
    ["3", "4"],
  ]);
  assert.equal(blocks[0]!.level, 1);
});

test("bdaToCanonical splits on [page N] markers", () => {
  const md = "\n\n[page 1]\nAlpha para.\n\n[page 2]\n## Head\nBeta para.";
  const doc = bdaToCanonical({ markdown: md }, META);
  assert.equal(doc.pages.length, 2);
  assert.deepEqual(
    doc.pages.map((p) => p.pageNo),
    [1, 2],
  );
  assert.equal(doc.pages[0]!.source, "bda");
  assert.ok(doc.pages[1]!.blocks.some((b) => b.kind === "heading"));
});

test("bdaToCanonical with no markers yields one page", () => {
  const doc = bdaToCanonical({ markdown: "Just text.", pageCount: 5 }, META);
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pageCount, 5); // trusts BDA's page count when given
});

test("sheetsToCanonical makes one page + table per non-empty sheet", () => {
  const doc = sheetsToCanonical(
    [
      { name: "Claims", rows: [["Name", "Amount"], ["A", "10"], ["B", "20"]] },
      { name: "Empty", rows: [["", ""]] },
    ],
    { fileName: "x.xlsx" },
  );
  assert.equal(doc.pages.length, 1);
  const table = doc.pages[0]!.blocks.find((b) => b.kind === "table")!;
  assert.deepEqual(table.table!.header, ["Name", "Amount"]);
  assert.equal(table.table!.rows.length, 2);
  assert.equal(doc.pages[0]!.source, "sheet");
});

test("pagesToCanonical maps client pages to para blocks, skips empties, keeps page nums", () => {
  const doc = pagesToCanonical(
    [
      { page: 1, text: "Para one.\n\nPara two." },
      { page: 2, text: "   " },
      { page: 3, text: "Solo." },
    ],
    { fileName: "c.pdf" },
  );
  assert.equal(doc.pages.length, 2);
  assert.deepEqual(
    doc.pages.map((p) => p.pageNo),
    [1, 3],
  );
  assert.equal(doc.pages[0]!.blocks.length, 2);
  assert.ok(doc.pages[0]!.blocks.every((b) => b.kind === "para"));
});

test("textToCanonical paginates on paragraph boundaries", () => {
  const paras = ["p".repeat(40), "q".repeat(40), "r".repeat(40)].join("\n\n");
  const doc = textToCanonical(paras, { fileName: "n.txt" }, 50);
  assert.ok(doc.pages.length >= 2, "should split into multiple pages");
  assert.equal(doc.pages[0]!.source, "text");
  assert.ok(doc.pages.every((p) => p.blocks.every((b) => b.kind === "para")));
});
