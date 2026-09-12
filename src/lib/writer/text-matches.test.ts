import { test } from "node:test";
import assert from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { findTextMatches } from "./text-matches.ts";

const s = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", attrs: { blockRevision: { default: null } } },
    table: { group: "block", content: "row+" },
    row: { content: "cell+" },
    cell: { content: "paragraph+" },
    hardBreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
  marks: { bold: {}, italic: {}, del: {} },
});
const txt = (text: string, mark?: string) => s.text(text, mark ? [s.mark(mark)] : []);
const p = (...children: ReturnType<typeof txt>[]) => s.node("paragraph", null, children);

test("a phrase spanning bold/italic has exact positions and preserves run metadata", () => {
  const doc = s.node("doc", null, [
    p(txt("The "), txt("motion ", "bold"), txt("is granted", "italic"), txt(".")),
  ]);
  const [m] = findTextMatches(doc, -1, "motion is granted");
  assert.equal(doc.textBetween(m.from, m.to), "motion is granted");
  assert.equal(m.runs.length, 2);
  assert.equal(m.runs[0].marks[0].type.name, "bold");
  assert.equal(m.runs[1].marks[0].type.name, "italic");
});
test("matches in every table cell, without crossing cell or paragraph boundaries", () => {
  const doc = s.node("doc", null, [
    s.node("table", null, [
      s.node("row", null, [
        s.node("cell", null, [p(txt("A"), txt("B", "bold"))]),
        s.node("cell", null, [p(txt("AB"))]),
      ]),
    ]),
  ]);
  assert.equal(findTextMatches(doc, -1, "AB").length, 2);
  assert.equal(findTextMatches(doc, -1, "BA").length, 0);
});
test("deletions and hard breaks form barriers, including deleted paragraphs", () => {
  const doc = s.node("doc", null, [
    p(txt("a"), txt("gone", "del"), txt("b")),
    p(txt("a"), s.node("hardBreak"), txt("b")),
    s.node("paragraph", { blockRevision: { kind: "del" } }, [txt("ab")]),
  ]);
  assert.equal(findTextMatches(doc, -1, "ab").length, 0);
  assert.equal(findTextMatches(doc, -1, "gone").length, 0);
});
test("literal regex characters, repeated matches, and Unicode retain original offsets", () => {
  const doc = s.node("doc", null, [p(txt("İ (A+B) (a+b) 🙂"))]);
  const matches = findTextMatches(doc, -1, "(a+b)", false);
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => doc.textBetween(m.from, m.to)),
    ["(A+B)", "(a+b)"],
  );
  assert.equal(findTextMatches(doc, -1, "").length, 0);
});

import { navigateDocument } from "./document-navigation.ts";
test("complete outlines reach middle blocks and reject stale pagination after edits", () => {
  const doc = s.node(
    "doc",
    null,
    Array.from({ length: 600 }, (_, i) => p(txt(i === 305 ? "MIDDLE AUTHORITY" : `Block ${i}`))),
  );
  let offset = 0;
  const indexes: unknown[] = [];
  const first = navigateDocument(doc, {});
  do {
    const page = navigateDocument(doc, { offset, revision: first.revision });
    indexes.push(...page.results.map((r) => r.blockIndex));
    offset = page.nextOffset ?? -1;
  } while (offset >= 0);
  assert.equal(indexes.length, 600);
  assert.equal(new Set(indexes).size, 600);
  assert.equal(
    navigateDocument(doc, { query: "MIDDLE AUTHORITY" }, true).results[0].blockIndex,
    305,
  );
  const changed = s.node("doc", null, [p(txt("New"))]);
  assert.throws(
    () => navigateDocument(changed, { offset: 40, revision: first.revision }),
    /Document changed/,
  );
});
