import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { officeExtractionPython, extractedPagePython } from "./office-extraction.ts";

function runPython(code: string) {
  const run = spawnSync("python", ["-c", code], { encoding: "utf8", maxBuffer: 2_000_000 });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  return run.stdout;
}
function clean(dir: string, name: string) {
  for (const file of [name, name + ".extracted.txt"]) {
    try {
      unlinkSync(file);
    } catch {
      /* Failed extraction may not create a sidecar. */
    }
  }
  rmdirSync(dir);
}
test("DOCX extraction includes tables, footnotes, later text and excludes deletions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-docx-")),
    name = join(dir, "fixture.docx");
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>${"a".repeat(70000)}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>TABLE CELL</w:t></w:r><w:del><w:r><w:delText>DELETED</w:delText></w:r></w:del></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>LAST PARAGRAPH</w:t></w:r></w:p></w:body></w:document>`,
  );
  zip.file(
    "word/footnotes.xml",
    `<w:footnotes xmlns:w="${ns}"><w:footnote w:id="1"><w:p><w:r><w:t>FOOTNOTE SOURCE</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  );
  writeFileSync(name, await zip.generateAsync({ type: "nodebuffer" }));
  try {
    const out = JSON.parse(
      runPython(officeExtractionPython(name)).match(/<<DOC>>([\s\S]*)<<END>>/)![1],
    );
    assert.equal(out.error, undefined);
    assert.equal(out.meta.nextOffset, 64000);
    const full = readFileSync(name + ".extracted.txt", "utf8");
    assert.match(full, /TABLE CELL/);
    assert.match(full, /FOOTNOTE SOURCE/);
    assert.match(full, /LAST PARAGRAPH/);
    assert.doesNotMatch(full, /DELETED/);
    assert.equal([...full].length, out.chars);
  } finally {
    clean(dir, name);
  }
});
for (const kind of ["xlsx", "pptx"] as const) {
  test(`complete ${kind} extraction reaches later data and notes`, () => {
    const dir = mkdtempSync(join(tmpdir(), "office-native-")),
      name = join(dir, `fixture.${kind}`);
    const setup =
      kind === "xlsx"
        ? `
import openpyxl
wb=openpyxl.Workbook()
for i in range(14):
 ws=wb.active if i==0 else wb.create_sheet('Sheet'+str(i+1))
 for j in range(70): ws.append(['Row '+str(j+1),j])
ws['A70']='FINAL SHEET ROW'
ws['B71']='=SUM(B1:B70)'
ws.sheet_state='hidden'
wb.save(${JSON.stringify(name)})
`
        : `
from pptx import Presentation
from pptx.util import Inches
prs=Presentation()
slide=prs.slides.add_slide(prs.slide_layouts[6])
table=slide.shapes.add_table(2,2,Inches(1),Inches(1),Inches(5),Inches(2)).table
table.cell(1,1).text='TABLE EVIDENCE'
slide.notes_slide.notes_text_frame.text='SPEAKER NOTE AUTHORITY'
prs.save(${JSON.stringify(name)})
`;
    try {
      runPython(setup);
      const out = JSON.parse(
        runPython(officeExtractionPython(name)).match(/<<DOC>>([\s\S]*)<<END>>/)![1],
      );
      assert.equal(out.error, undefined);
      if (kind === "xlsx") {
        assert.equal(out.meta.sheets.length, 14);
        assert.match(out.text, /FINAL SHEET ROW/);
        assert.match(out.text, /SUM\(B1:B70\)/);
        assert.match(out.text, /not recalculated/);
        assert.match(out.text, /hidden/);
      } else {
        assert.match(out.text, /TABLE EVIDENCE/);
        assert.match(out.text, /SPEAKER NOTE AUTHORITY/);
      }
    } finally {
      clean(dir, name);
    }
  });
}
test("native byte paging preserves UTF-8 characters at boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-pages-")),
    name = join(dir, "text");
  const original = "a".repeat(255999) + "🙂終" + "b".repeat(300000) + "TAIL";
  writeFileSync(name + ".extracted.txt", original);
  try {
    let offset: number | null = 0;
    const pages: string[] = [];
    while (offset !== null) {
      const page = JSON.parse(
        runPython(extractedPagePython(name, offset)).match(/<<PAGE>>([\s\S]*)<<END>>/)![1],
      );
      assert.ok(page.nextOffset === null || page.nextOffset > offset);
      pages.push(page.text);
      offset = page.nextOffset;
    }
    assert.equal(pages.join(""), original);
  } finally {
    clean(dir, name);
  }
});
