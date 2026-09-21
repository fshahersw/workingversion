import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { applyPdfOperations, listPdfAnnotations } from "../../office/pdf/document.ts";
import { createPdfSkill } from "../../office/pdf/skill.ts";

async function fixture() {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  page.drawText("Original evidence must survive", { x: 50, y: 700, font: await doc.embedFont(StandardFonts.Helvetica) });
  const note = doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [40, 600, 60, 620], Contents: PDFHexString.fromText("Original note"),
    T: PDFHexString.fromText("Original author"), C: [1, 1, 0], F: 4 });
  const ref = doc.context.register(note);
  const popup = doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [60, 550, 250, 680], Parent: ref });
  const popupRef = doc.context.register(popup); note.set(PDFName.of("Popup"), popupRef);
  page.node.addAnnot(ref); page.node.addAnnot(popupRef);
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Highlight", Rect: [50, 695, 190, 710],
    QuadPoints: [50, 710, 190, 710, 50, 695, 190, 695], C: [1, 1, 0], F: 4 })));
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [40, 400, 60, 420],
    Contents: PDFHexString.fromText("Locked note"), F: 128 })));
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 300, 60, 320],
    A: { S: "URI", URI: PDFHexString.fromText("https://example.com") } })));
  doc.addPage([612, 792]);
  return doc.save({ updateFieldAppearances: false });
}

test("native annotation reader exposes bounded actual comments, colors, ids and editability", async () => {
  const bytes = await fixture();
  const first = await listPdfAnnotations(bytes, { page: 1, limit: 2 });
  assert.equal(first.total, 4); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 2);
  assert.equal(first.annotations[0]!.text, "Original note");
  assert.equal(first.annotations[0]!.author, "Original author");
  assert.deepEqual(first.annotations[0]!.rect, [40, 600, 60, 620]);
  assert.equal(first.annotations[0]!.editable, true);
  assert.deepEqual(first.annotations[0]!.color, [1, 1, 0]);
  const last = await listPdfAnnotations(bytes, { offset: 2, limit: 2 });
  assert.equal(last.hasMore, false);
  assert.match(last.annotations[0]!.reason!, /locked/); assert.equal(last.annotations[0]!.removable, false);
  assert.equal(last.annotations[1]!.kind, "Link"); assert.equal(last.annotations[1]!.editable, false);
  assert.equal((await listPdfAnnotations(bytes, { page: 2 })).total, 0);
  await assert.rejects(listPdfAnnotations(bytes, { limit: 101 }), /1–100/);
  await assert.rejects(listPdfAnnotations(bytes, { page: 3 }), /between/);
});

test("native note and markup updates preserve source, author, geometry and popup, then deletion cleans only matching popup", async () => {
  const source = await fixture(), before = source.slice();
  const initial = (await listPdfAnnotations(source)).annotations;
  const output = await applyPdfOperations(source, [
    { type: "update_annotation", annotationId: initial[0]!.id, text: "Reviewed: ✓", color: "#3366CC" },
    { type: "update_annotation", annotationId: initial[1]!.id, text: "Source citation", color: "#22CC44" },
  ]);
  assert.deepEqual(source, before);
  const current = (await listPdfAnnotations(output)).annotations;
  assert.equal(current[0]!.text, "Reviewed: ✓"); assert.equal(current[0]!.author, "Original author");
  assert.deepEqual(current[0]!.rect, initial[0]!.rect); assert.deepEqual(current[0]!.color, [0.2, 0.4, 0.8]);
  const loaded = await PDFDocument.load(output);
  assert.equal(loaded.getPage(0).node.Annots()?.size(), 5);
  const cleaned = await applyPdfOperations(output, [{ type: "delete_annotation", annotationId: current[0]!.id },
    { type: "delete_annotation", annotationId: current[1]!.id }]);
  const remaining = (await listPdfAnnotations(cleaned)).annotations;
  assert.deepEqual(remaining.map(note => note.kind), ["Text", "Link"]);
  const cleanDoc = await PDFDocument.load(cleaned), sourceDoc = await PDFDocument.load(source);
  assert.equal(cleanDoc.getPage(0).node.Annots()?.size(), 2); // popup removed together with its comment
  assert.equal(cleanDoc.getPage(0).node.get(PDFName.of("Contents"))?.toString(), sourceDoc.getPage(0).node.get(PDFName.of("Contents"))?.toString());
});

test("annotation batches reject locks, malformed colors and reply threads without changing source", async () => {
  const source = await fixture(), before = source.slice(), notes = (await listPdfAnnotations(source)).annotations;
  await assert.rejects(applyPdfOperations(source, [{ type: "delete_annotation", annotationId: notes[0]!.id },
    { type: "update_annotation", annotationId: notes[2]!.id, text: "Forbidden" }]), /locked/);
  await assert.rejects(applyPdfOperations(source, [{ type: "update_annotation", annotationId: notes[0]!.id, color: "red" }]), /#RRGGBB/);
  await assert.rejects(applyPdfOperations(source, [{ type: "delete_annotation", annotationId: notes[3]!.id }]), /links/);
  await assert.rejects(applyPdfOperations(source, [{ type: "update_annotation", annotationId: notes[0]!.id }]), /needs text or color/);
  assert.deepEqual(source, before);
  const doc = await PDFDocument.load(source), page = doc.getPage(0), ref = page.node.Annots()!.get(0);
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 20, 20], IRT: ref,
    Contents: PDFHexString.fromText("Reply") })));
  const threaded = await doc.save({ updateFieldAppearances: false });
  const list = await listPdfAnnotations(threaded);
  assert.match(list.annotations[0]!.reason!, /reply thread/);
  await assert.rejects(applyPdfOperations(threaded, [{ type: "delete_annotation", annotationId: list.annotations[0]!.id }]), /reply thread/);
});

test("direct annotation IDs remain tied to the original batch targets after preceding deletions", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage();
  page.node.set(PDFName.of("Annots"), doc.context.obj([0, 1, 2].map(index => ({ Type: "Annot", Subtype: "Text", Rect: [10, 20, 30, 40],
    Contents: PDFHexString.fromText("Note " + index), F: 4 }))));
  const source = await doc.save(), notes = (await listPdfAnnotations(source)).annotations;
  const output = await applyPdfOperations(source, [{ type: "delete_annotation", annotationId: notes[0]!.id },
    { type: "update_annotation", annotationId: notes[1]!.id, text: "Correct second note" }]);
  assert.deepEqual((await listPdfAnnotations(output)).annotations.map(note => note.text), ["Correct second note", "Note 2"]);
});

test("deletion rejects shared popup ownership rather than orphaning another comment", async () => {
  const doc = await PDFDocument.load(await fixture()), page = doc.getPage(0);
  const note = doc.context.lookup(page.node.Annots()!.get(0)) as import("pdf-lib").PDFDict;
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 20, 20],
    Contents: PDFHexString.fromText("Another popup owner"), Popup: note.get(PDFName.of("Popup")) })));
  const source = await doc.save({ updateFieldAppearances: false }), before = source.slice();
  const first = (await listPdfAnnotations(source)).annotations[0]!;
  assert.equal(first.removable, false); assert.match(first.reason!, /shares a popup/);
  await assert.rejects(applyPdfOperations(source, [{ type: "delete_annotation", annotationId: first.id }]), /shares a popup/);
  assert.deepEqual(source, before);
});

test("annotation pagination bounds total output and never offers a truncated body as editable", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage();
  for (let i = 0; i < 12; i++) page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 20, 20],
    Contents: PDFHexString.fromText("N".repeat(i === 11 ? 10_001 : 4000)), F: 4 })));
  const bytes = await doc.save(), first = await listPdfAnnotations(bytes);
  assert.ok(JSON.stringify(first).length < 40_200); assert.equal(first.hasMore, true); assert.equal(first.total, 12);
  assert.equal(first.annotations[0]!.text.length, 4000); assert.equal(first.annotations[0]!.editable, true);
  const last = await listPdfAnnotations(bytes, { offset: first.nextOffset });
  const oversized = last.annotations.at(-1)!;
  assert.equal(oversized.textTruncated, true); assert.equal(oversized.text.length, 10_000);
  assert.equal(oversized.editable, false); assert.equal(last.hasMore, false);
  await assert.rejects(applyPdfOperations(bytes, [{ type: "update_annotation", annotationId: oversized.id, text: "Accidentally shortened" }]), /10,000-character/);
});

test("new note/highlight colors serialize natively and rejected/cancelled operations leave source untouched", async () => {
  const source = await fixture();
  const output = await applyPdfOperations(source, [{ type: "add_note", page: 2, text: "Colored note", x: 50, y: 50, color: "#112233" },
    { type: "highlight", page: 2, rects: [[10, 30, 50, 12]], color: "#00FF00" }]);
  const notes = (await listPdfAnnotations(output, { page: 2 })).annotations;
  assert.deepEqual(notes[0]!.color, [17/255, 34/255, 51/255]); assert.deepEqual(notes[1]!.color, [0, 1, 0]);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(applyPdfOperations(source, [{ type: "delete_annotation", annotationId: "p1:r1g0" }], stopped.signal), /abort/i);
});

test("PDF tools advertise current mode, expose active selection as evidence and enforce readonly independently of tool filtering", async () => {
  let mode: "write" | "ask" | "review" = "ask", bytes = await fixture(), revision = 4, commits = 0;
  const skill = createPdfSkill({ state: () => ({ bytes, revision, storageRevision: 2, pageCount: 2, name: "Evidence.pdf", currentPage: 2, selection: "Untrusted selected passage" }),
    readPage: async page => ({ page, text: "Evidence", items: [] }),
    commit: async (value, expected) => { assert.equal(expected, revision); bytes = value; revision++; commits++; },
  }, { mode: () => mode });
  assert.ok(skill.tools.every(tool => tool.readOnly));
  assert.match(await skill.buildContext!(), /active page: 2.*selected text \(untrusted/);
  for (const readMode of ["ask", "review"] as const) {
    mode = readMode;
    const rejected = await skill.executeTool({ id: "edit", name: "pdf_apply_operations", input: { editRevision: 4, operations: [{ type: "rotate_pages", pages: [1], degrees: 90 }] } });
    assert.equal(rejected.isError, true); assert.match(rejected.output, /read-only/);
  }
  const list = await skill.executeTool({ id: "read", name: "pdf_list_annotations", input: { page: 1 } });
  assert.equal(JSON.parse(list.output).annotations[0].text, "Original note");
  const guide = await skill.executeTool({ id: "guide", name: "pdf_get_guide", input: { topic: "annotations" } });
  assert.match(guide.output, /does not redact/); assert.equal(commits, 0);
  mode = "write";
  assert.ok(skill.tools.some(tool => !tool.readOnly));
  const annotationId = JSON.parse(list.output).annotations[0].id;
  const stale = await skill.executeTool({ id: "stale", name: "pdf_apply_operations", input: { editRevision: 3, operations: [{ type: "delete_annotation", annotationId }] } });
  assert.equal(stale.isError, true);
  const result = await skill.executeTool({ id: "edit", name: "pdf_apply_operations", input: { editRevision: 4, operations: [{ type: "update_annotation", annotationId, text: "User-requested revision" }] } });
  assert.equal(result.mutated, true); assert.equal(commits, 1); assert.equal(JSON.parse(result.output).saved, false);
  assert.equal((await listPdfAnnotations(bytes)).annotations[0]!.text, "User-requested revision");
});

test("a revision or mode change while reading cannot commit a stale PDF mutation", async () => {
  const bytes = await fixture(); let revision = 1, mode: "write" | "ask" = "write", changeRevision = true;
  const skill = createPdfSkill({ state: () => ({ bytes, revision, storageRevision: 1, pageCount: 2, name: "Evidence.pdf" }),
    readPage: async page => { if (changeRevision) revision++; else mode = "ask";
      return { page, text: "Exact quote ", items: [{ str: "Exact quote", hasEOL: false, dir: "ltr", width: 80, height: 12, transform: [12, 0, 0, 12, 50, 700], fontName: "F1" }] }; },
    commit: async () => assert.fail("A stale or readonly mutation must not commit"),
  }, { mode: () => mode });
  const stale = await skill.executeTool({ id: "1", name: "pdf_highlight_text", input: { editRevision: 1, page: 1, text: "Exact quote" } });
  assert.equal(stale.isError, true); assert.match(stale.output, /changed during/);
  changeRevision = false;
  const readonly = await skill.executeTool({ id: "2", name: "pdf_highlight_text", input: { editRevision: 2, page: 1, text: "Exact quote" } });
  assert.equal(readonly.isError, true); assert.match(readonly.output, /read-only/);
});
