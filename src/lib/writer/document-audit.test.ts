import assert from "node:assert/strict";
import { test } from "node:test";

import { auditDocumentModel, formatDocAudit, type AuditBlock, type AuditModel } from "./document-audit.ts";

const LETTER = { pageWidth: 12240, pageHeight: 15840, marginTop: 1440, marginRight: 1440, marginBottom: 1440, marginLeft: 1440 };
const run = (text: string, extra: Partial<AuditBlock["runs"][number]> = {}) => ({ text, bold: false, color: null, link: false, ...extra });
const para = (index: number, text: string, extra: Partial<AuditBlock> = {}): AuditBlock => ({
  index,
  type: "paragraph",
  text,
  runs: text ? [run(text)] : [],
  align: null,
  indentLeft: null,
  pageBreakBefore: false,
  noteRefs: [],
  ...extra,
});
const heading = (index: number, text: string, level = 1, extra: Partial<AuditBlock> = {}): AuditBlock => ({ ...para(index, text), type: "heading", level, ...extra });
const body = "The court held that the manufacturer's warning was inadequate as a matter of law, and the jury's verdict on the failure-to-warn count was supported by the evidence presented at trial.";

function model(blocks: AuditBlock[], extra: Partial<AuditModel> = {}): AuditModel {
  return { blocks, footnotes: [], endnotes: [], section: LETTER, ...extra };
}

test("a clean brief passes", () => {
  const m = model([
    heading(0, "Argument"),
    para(1, body, { noteRefs: [{ kind: "footnote", id: "1", num: 1 }] }),
    heading(2, "I. The warning was inadequate", 2),
    para(3, body, { noteRefs: [{ kind: "footnote", id: "2", num: 2 }] }),
  ], { footnotes: [{ id: "1", text: "Hardeman v. Monsanto Co., 997 F.3d 941 (9th Cir. 2021)." }, { id: "2", text: "Id. at 960." }] });
  assert.deepEqual(auditDocumentModel(m), []);
  assert.match(formatDocAudit([]), /Passed/);
});

test("footnotes: orphan definitions, dangling references, duplicate marks and duplicate text", () => {
  const m = model(
    [para(0, body, { noteRefs: [{ kind: "footnote", id: "1", num: 1 }, { kind: "footnote", id: "9", num: 9 }] }), para(1, body, { noteRefs: [{ kind: "footnote", id: "1", num: 1 }] })],
    {
      footnotes: [
        { id: "1", text: "Hardeman v. Monsanto Co., 997 F.3d 941 (9th Cir. 2021)." },
        { id: "2", text: "Hardeman v. Monsanto Co., 997 F.3d 941 (9th Cir. 2021)." }, // re-inserted authority: orphan + duplicate text
        { id: "3", text: "Wyeth v. Levine, 555 U.S. 555 (2009)." }, // orphan
      ],
    },
  );
  const issues = auditDocumentModel(m);
  assert.ok(issues.some((i) => /Orphan footnotes: 2 definitions/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /Dangling footnote reference/.test(i) && /block 0/.test(i)));
  assert.ok(issues.some((i) => /Duplicate footnote reference marks/.test(i)));
  assert.ok(issues.some((i) => /Duplicate footnote text/.test(i) && /short form/.test(i)));
  assert.match(formatDocAudit(issues), /4 findings/);
});

test("bold body paragraphs that read like titles are flagged; bold sentences are not", () => {
  const m = model([
    para(0, "Statement of Facts", { runs: [run("Statement of Facts", { bold: true })] }),
    para(1, body),
    para(2, "This point is important.", { runs: [run("This point is important.", { bold: true })] }),
    para(3, body),
  ]);
  const issues = auditDocumentModel(m);
  const hit = issues.find((i) => /Bold paragraph used as heading/.test(i));
  assert.ok(hit);
  assert.match(hit!, /block 0/);
  assert.ok(!/block 2/.test(hit!), "a bold sentence ending in a period is emphasis");
});

test("grey citation text is flagged; links and headings are exempt", () => {
  const m = model([
    heading(0, "Argument", 1, { runs: [run("Argument", { color: "1f3864" })] }),
    para(1, body, { runs: [run(body.slice(0, 60)), run(body.slice(60), { color: "666666" })] }),
    para(2, "See the docket", { runs: [run("See the docket", { color: "0563c1", link: true })] }),
    para(3, body),
  ]);
  const issues = auditDocumentModel(m);
  const hit = issues.find((i) => /Colored body text/.test(i));
  assert.ok(hit);
  assert.match(hit!, /#666666 in block 1/);
  assert.ok(!/0563c1/.test(hit!) && !/1f3864/.test(hit!));
});

test("page geometry: odd paper, margins out of range, table wider than the text area", () => {
  const m = model(
    [para(0, body), { ...para(1, "cells"), type: "table", tableWidthPx: 800, tableWidthPct: null }],
    { section: { pageWidth: 12240, pageHeight: 15840, marginTop: 1440, marginRight: 4320, marginBottom: 1440, marginLeft: 4320 } },
  );
  const issues = auditDocumentModel(m);
  assert.ok(issues.some((i) => /Margins out of range: right 3", left 3"/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /Table wider than the text area in block 1/.test(i)));
  const odd = auditDocumentModel(model([para(0, body)], { section: { ...LETTER, pageWidth: 9000, pageHeight: 13000 } }));
  assert.ok(odd.some((i) => /Unusual paper size/.test(i)));
  assert.deepEqual(auditDocumentModel(model([para(0, body)], { section: { ...LETTER, pageWidth: 15840, pageHeight: 12240 } })), [], "landscape letter is fine");
});

test("empty and orphan paragraphs: runs of blanks, leading/trailing blanks, headings with no body", () => {
  const m = model([
    para(0, ""),
    heading(1, "Introduction"),
    para(2, body),
    para(3, ""),
    para(4, ""),
    heading(5, "Argument"),
    heading(6, "Conclusion"),
  ]);
  const issues = auditDocumentModel(m);
  assert.ok(issues.some((i) => /starts with an empty paragraph/.test(i)));
  assert.ok(issues.some((i) => /consecutive empty paragraphs \(blocks 3–4\)/.test(i)));
  const orphans = issues.find((i) => /Headings with no body text/.test(i));
  assert.ok(orphans);
  assert.match(orphans!, /blocks 5, 6/);
  // a page-break carrier paragraph is not "empty spacing"
  const pb = auditDocumentModel(model([para(0, body), para(1, "", { pageBreakBefore: true }), para(2, body)]));
  assert.ok(!pb.some((i) => /empty paragraph/.test(i)));
});

test("alignment: a couple of centered long paragraphs among justified body text, mixed heading alignment", () => {
  const blocks: AuditBlock[] = [];
  for (let i = 0; i < 6; i++) blocks.push(para(i, body, { align: "both" }));
  blocks.push(para(6, body, { align: "center" }));
  blocks.push(heading(7, "Argument", 2, { align: "left" }));
  blocks.push(heading(8, "Conclusion", 2, { align: "center" }));
  const issues = auditDocumentModel(model(blocks));
  assert.ok(issues.some((i) => /Inconsistent alignment: 1 long body paragraph center-aligned \(block 6\) while the rest are justified/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /Level-2 headings are not aligned alike/.test(i)));
});

test("findings are capped", () => {
  const blocks: AuditBlock[] = [];
  for (let i = 0; i < 40; i++) blocks.push(heading(i, `Heading ${i}`, 1, { align: i % 2 ? "center" : "left" }));
  const issues = auditDocumentModel(model(blocks));
  assert.ok(issues.length <= 12);
});

test("requested colors, bare headings, table widths and spacing remain advisory during automatic verification", () => {
  const m = model([
    heading(0, "Title"), heading(1, "Test facts", 1),
    para(2, body, { runs: [run(body, { color: "ff0000" })] }),
    { ...para(3, "Requested table"), type: "table", tableWidthPx: 900 },
    para(4, ""), para(5, ""), heading(6, "Requested outline heading"),
  ], { section: { ...LETTER, pageWidth: 9000, pageHeight: 13000 } });
  const before = structuredClone(m);
  const findings = auditDocumentModel(m);
  assert.ok(findings.some(i => i.startsWith("Colored body text")));
  assert.ok(findings.some(i => /no body text beneath/.test(i)));
  assert.ok(findings.some(i => /wider than the text area/.test(i)));
  assert.deepEqual(auditDocumentModel(m, { structuralOnly: true }), []);
  assert.deepEqual(m, before, "audit never mutates requested formatting or structure");
  assert.match(formatDocAudit(findings), /Style findings are advisory/);
  assert.doesNotMatch(formatDocAudit(findings), /Fix these with the document tools now/);
});

test("automatic verification reports new broken references/geometry and ignores pre-existing defects even when blocks move", () => {
  const before = model([para(0, body, { noteRefs: [{ kind: "footnote", id: "already-missing", num: 1 }] })]);
  const moved = model([heading(0, "New requested title"), para(1, body, { noteRefs: [{ kind: "footnote", id: "already-missing", num: 1 }] })]);
  assert.deepEqual(auditDocumentModel(moved, { structuralOnly: true, baseline: before }), []);
  const broken = structuredClone(moved);
  broken.blocks[1]!.noteRefs.push({ kind: "footnote", id: "newly-missing", num: 2 });
  const issues = auditDocumentModel(broken, { structuralOnly: true, baseline: before });
  assert.equal(issues.length, 1); assert.match(issues[0]!, /Dangling footnote/); assert.match(issues[0]!, /never invent/);
  const invalid = model([para(0, body)], { section: { ...LETTER, marginLeft: LETTER.pageWidth } });
  assert.ok(auditDocumentModel(invalid, { structuralOnly: true, baseline: before }).some(i => /Invalid page geometry/.test(i)));
  assert.deepEqual(auditDocumentModel(invalid, { structuralOnly: true, baseline: invalid }), []);
});

test("newly detached note content is retained and not auto-deleted to satisfy an audit", () => {
  const before = model([para(0, body, { noteRefs: [{ kind: "footnote", id: "n1", num: 1 }] })], { footnotes: [{ id: "n1", text: "Known source text." }] });
  const after = structuredClone(before); after.blocks[0]!.noteRefs = [];
  const issues = auditDocumentModel(after, { structuralOnly: true, baseline: before });
  assert.equal(issues.length, 1); assert.match(issues[0]!, /Preserve the note's text/);
  assert.deepEqual(after.footnotes, before.footnotes);
});
