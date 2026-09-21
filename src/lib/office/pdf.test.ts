import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { applyPdfOperations, createBlankPdf, listPdfFields, validatePdf } from "../../office/pdf/document.ts";
import { extractPdf } from "../ingest/pdf.server.ts";
import { createPdfSkill } from "../../office/pdf/skill.ts";

async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("First page evidence", { x: 50, y: 700, size: 12, font });
  doc.addPage().drawText("Second page evidence", { x: 50, y: 700, size: 12, font });
  return doc.save();
}
function unusualPdf(hex = false) {
  const stream = (text: string) => "<< /Length " + Buffer.byteLength(text) + " >>\nstream\n" + text + "\nendstream";
  const literal = (text: string) => hex ? "<" + Buffer.from(text).toString("hex") + ">" : "(" + text + ")";
  const objects: Array<[number, string]> = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"],
    [5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"],
    [6, stream("BT /F1 12 Tf 50 700 Td " + literal("SECOND PAGE") + " Tj ET")],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"],
    [4, stream("BT /F1 12 Tf 50 700 Td " + literal("FIRST PAGE") + " Tj ET")],
    [7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  let pdf = "%PDF-1.4\n"; const offsets: number[] = [];
  for (const [id, body] of objects) { offsets[id] = Buffer.byteLength(pdf); pdf += id + " 0 obj\n" + body + "\nendobj\n"; }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 8\n0000000000 65535 f \n";
  for (let i = 1; i < 8; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return new Uint8Array(Buffer.from(pdf));
}

test("PDF source extraction follows page-tree order, not physical object order", async () => {
  assert.deepEqual((await extractPdf(unusualPdf())).pages, ["FIRST PAGE", "SECOND PAGE"]);
});
test("PDF source extraction decodes hexadecimal strings and compressed object streams", async () => {
  assert.deepEqual((await extractPdf(unusualPdf(true))).pages, ["FIRST PAGE", "SECOND PAGE"]);
  assert.deepEqual((await extractPdf(await fixture())).pages, ["First page evidence", "Second page evidence"]);
});
test("PDF operations preserve source bytes and reorder real pages", async () => {
  const source = await fixture(), before = source.slice();
  const output = await applyPdfOperations(source, [{ type: "reorder_pages", order: [2, 1] }, { type: "rotate_pages", pages: [1], degrees: 90 }]);
  assert.deepEqual(source, before);
  assert.deepEqual((await extractPdf(output)).pages, ["Second page evidence", "First page evidence"]);
  assert.equal((await PDFDocument.load(output)).getPage(0).getRotation().angle, 90);
});
test("PDF reorder preserves inherited page resources, size, crop and rotation", async () => {
  const doc = await PDFDocument.load(await fixture());
  const page = doc.getPage(0), root = doc.catalog.Pages();
  const resources = page.node.Resources()!;
  const parent = doc.context.obj({ Type: "Pages", Parent: doc.catalog.get(PDFName.of("Pages")), Count: 1, Kids: [page.ref],
    MediaBox: [0, 0, 300, 400], CropBox: [20, 30, 280, 370], Rotate: 90, Resources: resources });
  const parentRef = doc.context.register(parent);
  root.Kids().set(0, parentRef);
  page.node.set(PDFName.of("Parent"), parentRef);
  for (const name of ["Resources", "MediaBox", "CropBox", "Rotate"]) page.node.delete(PDFName.of(name));
  const source = await doc.save({ updateFieldAppearances: false });
  const output = await applyPdfOperations(source, [{ type: "reorder_pages", order: [2, 1] }]);
  const restored = (await PDFDocument.load(output)).getPage(1);
  assert.deepEqual(restored.getSize(), { width: 300, height: 400 });
  assert.deepEqual(restored.getCropBox(), { x: 20, y: 30, width: 260, height: 340 });
  assert.equal(restored.getRotation().angle, 90);
  assert.ok(restored.node.Resources()?.has(PDFName.of("Font")));
});
test("PDF invalid batch never publishes its earlier successful operation", async () => {
  const source = await fixture(), before = source.slice();
  await assert.rejects(applyPdfOperations(source, [{ type: "rotate_pages", pages: [1], degrees: 90 }, { type: "delete_pages", pages: [1, 2] }]), /at least one/);
  assert.deepEqual(source, before);
  assert.equal((await PDFDocument.load(source)).getPage(0).getRotation().angle, 0);
});
test("PDF notes, highlights and inserted text are persisted in native PDF bytes", async () => {
  const output = await applyPdfOperations(await fixture(), [
    { type: "add_note", page: 1, text: "Attorney review: ✓", x: 30, y: 600 },
    { type: "highlight", page: 1, rects: [[50, 698, 110, 12]] },
    { type: "add_text", page: 1, text: "Review copy", x: 50, y: 650, size: 12 },
  ]);
  const doc = await PDFDocument.load(output);
  assert.equal(doc.getPage(0).node.Annots()?.size(), 2);
  assert.match((await extractPdf(output)).pages[0]!, /Review copy/);
});
test("PDF form changes round-trip as field values and reject unknown options", async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage();
  const text = doc.getForm().createTextField("Name"); text.addToPage(page); text.setText("Before");
  const check = doc.getForm().createCheckBox("Approved"); check.addToPage(page, { x: 10, y: 10 });
  const source = await doc.save();
  const output = await applyPdfOperations(source, [{ type: "fill_form", name: "Name", value: "After" }, { type: "fill_form", name: "Approved", value: true }]);
  const fields = await listPdfFields(output);
  assert.equal(fields.find(f => f.name === "Name")?.value, "After");
  assert.equal(fields.find(f => f.name === "Approved")?.value, true);
  await assert.rejects(applyPdfOperations(source, [{ type: "fill_form", name: "missing", value: "x" }]), /missing/);
});
test("PDF admission rejects active content and unsafe authoring without silent stripping", async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: "alert(1)" }));
  await assert.rejects(validatePdf(await doc.save()), /scripts/);
  const remote = await PDFDocument.create(); const page = remote.addPage();
  page.node.addAnnot(remote.context.register(remote.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], A: { S: "SubmitForm", F: "https://example.invalid/submit" } })));
  await assert.rejects(validatePdf(await remote.save()), /external or executable/);
  const indirect = await PDFDocument.create(); const indirectPage = indirect.addPage();
  indirectPage.node.addAnnot(indirect.context.register(indirect.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10],
    A: { S: indirect.context.register(PDFName.of("SubmitForm")), F: "https://example.invalid/submit" } })));
  await assert.rejects(validatePdf(await indirect.save()), /external or executable/);
  await assert.rejects(applyPdfOperations(await createBlankPdf(), [{ type: "add_text", page: 1, text: "long line", x: 610, y: 40, size: 20 }]), /overflow/);
  await assert.rejects(validatePdf(new Uint8Array([1, 2, 3])), /PDF/);
});

test("PDF page organization refuses linked and tagged structures rather than breaking their references", async () => {
  const doc = await PDFDocument.load(await fixture());
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: [0, { S: "r" }] }));
  const source = await doc.save();
  await assert.rejects(applyPdfOperations(source, [{ type: "delete_pages", pages: [1] }]), /page labels/);
  await assert.rejects(applyPdfOperations(source, [{ type: "reorder_pages", order: [2, 1] }]), /page labels/);
  const rotated = await applyPdfOperations(source, [{ type: "rotate_pages", pages: [1], degrees: 90 }]);
  assert.equal((await PDFDocument.load(rotated)).getPage(0).getRotation().angle, 90);
});

test("PDF authoring respects nonzero visible crop coordinates", async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage([612, 792]);
  page.setCropBox(100, 100, 300, 400);
  const source = await doc.save();
  await assert.rejects(applyPdfOperations(source, [{ type: "add_note", page: 1, text: "outside crop", x: 50, y: 50 }]), /visible page/);
  const output = await applyPdfOperations(source, [{ type: "add_text", page: 1, text: "Inside crop", x: 110, y: 200 }]);
  assert.match((await extractPdf(output)).pages[0]!, /Inside crop/);
  page.setCropBox(-100, -100, 900, 1000);
  await assert.rejects(applyPdfOperations(await doc.save(), [{ type: "add_text", page: 1, text: "Hidden beyond MediaBox", x: 650, y: 100 }]), /visible page/);
});

test("PDF agent reports missing text coverage and returns bounded viewer captures without mutation", async () => {
  const skill = createPdfSkill({
    state: () => ({ bytes: new Uint8Array(), revision: 1, storageRevision: 1, pageCount: 2, name: "Scanned.pdf" }),
    readPage: async page => ({ page, text: page === 1 ? "Known clause" : "", items: [] }),
    capturePage: async () => ({ mime: "image/png", base64: "synthetic-test-image" }),
    commit: async () => assert.fail("Reader must not mutate"),
  });
  const read = await skill.executeTool({ id: "1", name: "pdf_read_pages", input: { start: 2 } });
  assert.match(JSON.parse(read.output).pages[0].textCoverage, /missing/);
  const search = await skill.executeTool({ id: "2", name: "pdf_search", input: { query: "clause" } });
  assert.deepEqual(JSON.parse(search.output).missingTextPages, [2]);
  const capture = await skill.executeTool({ id: "3", name: "pdf_capture_page", input: { page: 1 } });
  assert.equal(capture.images?.[0]?.mime, "image/png");
  assert.equal(capture.mutated, undefined);
});
test("PDF agent requires current revision and executes native operations, not prose promises", async () => {
  let bytes = await fixture(), revision = 7, commits = 0;
  const skill = createPdfSkill({
    state: () => ({ bytes, revision, storageRevision: 3, pageCount: 2, name: "Evidence.pdf" }),
    readPage: async page => ({ page, text: "Evidence text", items: [] }),
    commit: async (value, expected) => { assert.equal(expected, revision); bytes = value; revision++; commits++; },
  });
  const stale = await skill.executeTool({ id: "1", name: "pdf_apply_operations", input: { editRevision: 6, operations: [{ type: "rotate_pages", pages: [1], degrees: 90 }] } });
  assert.equal(stale.isError, true); assert.equal(commits, 0);
  const read = await skill.executeTool({ id: "2", name: "pdf_read_pages", input: { start: 1 } });
  assert.equal(JSON.parse(read.output).editRevision, 7); assert.equal(commits, 0);
  const edit = await skill.executeTool({ id: "3", name: "pdf_apply_operations", input: { editRevision: 7, operations: [{ type: "rotate_pages", pages: [1], degrees: 90 }] } });
  assert.equal(edit.mutated, true); assert.equal(commits, 1);
  assert.equal((await PDFDocument.load(bytes)).getPage(0).getRotation().angle, 90);
  const abort = new AbortController(); abort.abort();
  const stopped = await skill.executeTool({ id: "4", name: "pdf_apply_operations", input: { editRevision: 8, operations: [{ type: "delete_pages", pages: [2] }] } }, abort.signal);
  assert.equal(stopped.isError, true); assert.equal(commits, 1);
});
