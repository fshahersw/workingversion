import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { initializePdfium, executePdfium, executePdfiumTransaction, type PdfiumRequest } from "../../office/pdf/pdfium-core.ts";
import { applyPdfOperations, listPdfAnnotations, validatePdf, visiblePageBox } from "../../office/pdf/document.ts";
import { extractPdfPages, mergePdfPages, readPdfOutline } from "../../office/pdf/page-operations.ts";
import { listInsertedPdfText } from "../../office/pdf/inserted-text.ts";
import { createPdfSkill } from "../../office/pdf/skill.ts";
import { extractPdf } from "../ingest/pdf.server.ts";
import { runPdfium } from "../../office/pdf/pdfium-client.ts";

const wasm = await readFile(createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm"));
const engine = await initializePdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
async function fixture() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Original source text", { x: 50, y: 700, font, size: 12 });
  doc.getPage(0).drawText("Unchanged evidence", { x: 50, y: 650, font, size: 12 });
  doc.addPage([400, 500]).drawText("Second page", { x: 40, y: 400, font, size: 12 });
  return doc.save();
}
async function request(bytes: Uint8Array, operations?: PdfiumRequest["operations"]): Promise<PdfiumRequest> {
  const doc = await validatePdf(bytes); return { bytes, pages: [1], boxes: doc.getPages().map(visiblePageBox), ...(operations ? { operations } : {}) };
}
function renderPixel(bytes: Uint8Array, x: number, y: number) {
  const input = engine.pdfium._malloc(bytes.length); engine.pdfium.HEAPU8.set(bytes, input);
  const doc = engine.FPDF_LoadMemDocument(input, bytes.length, ""), page = engine.FPDF_LoadPage(doc, 0), bitmap = engine.FPDFBitmap_Create(612, 792, 1);
  try {
    engine.FPDFBitmap_FillRect(bitmap, 0, 0, 612, 792, 0xffffffff);
    engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 612, 792, 0, 0);
    const at = engine.FPDFBitmap_GetBuffer(bitmap) + (792 - y) * engine.FPDFBitmap_GetStride(bitmap) + x * 4;
    const [b, g, r, a] = engine.pdfium.HEAPU8.slice(at, at + 4); return [r, g, b, a];
  } finally { engine.FPDFBitmap_Destroy(bitmap); engine.FPDF_ClosePage(page); engine.FPDF_CloseDocument(doc); engine.pdfium._free(input); }
}
test("pinned WASM replaces real source text, preserves unrelated text/annotations and original bytes", async () => {
  const bytes = await applyPdfOperations(await fixture(), [{ type: "add_note", page: 1, text: "Preserve review", x: 20, y: 20 }]), before = bytes.slice();
  const original = executePdfium(engine, await request(bytes));
  assert.equal(original.objects[0]!.text, "Original source text");
  const edited = executePdfium(engine, await request(bytes, [{ type: "replace_text", id: original.objects[0]!.id, expectedText: "Original source text", text: "Revised source text" }]));
  assert.deepEqual(bytes, before);
  assert.deepEqual((await extractPdf(edited.bytes!)).pages, ["Revised source text\nUnchanged evidence", "Second page"]);
  assert.equal((await listPdfAnnotations(edited.bytes!)).annotations[0]!.text, "Preserve review");
  const reopened = executePdfium(engine, await request(edited.bytes!)).objects;
  assert.deepEqual(reopened[0]!.matrix, original.objects[0]!.matrix);
  assert.equal(reopened[0]!.font, original.objects[0]!.font);
});
test("native deletion removes exactly the selected source object and rejects stale text or unsupported glyphs atomically", async () => {
  const bytes = await fixture(), before = bytes.slice(), q = await request(bytes);
  assert.throws(() => executePdfium(engine, { ...q, operations: [{ type: "replace_text", id: "p1:o0", expectedText: "Wrong", text: "changed" }] }), /exact current text/);
  assert.throws(() => executePdfium(engine, { ...q, operations: [{ type: "replace_text", id: "p1:o0", expectedText: "Original source text", text: "日本語" }] }), /glyph coverage/);
  assert.throws(() => executePdfium(engine, { ...q, operations: [{ type: "delete_object", id: "p1:o0", expectedKind: "image" }] }), /kind/);
  const deleted = executePdfium(engine, { ...q, operations: [{ type: "delete_object", id: "p1:o0", expectedKind: "text" }] }).bytes!;
  assert.deepEqual((await extractPdf(deleted)).pages, ["Unchanged evidence", "Second page"]);
  assert.deepEqual(bytes, before);
});
test("native repeated edits validate the final replacement and object transforms reject off-page placement", async () => {
  const bytes = await fixture(), q = await request(bytes);
  const result = executePdfium(engine, { ...q, operations: [
    { type: "replace_text", id: "p1:o0", expectedText: "Original source text", text: "First change" },
    { type: "replace_text", id: "p1:o0", expectedText: "First change", text: "Final change" },
    { type: "set_object_color", id: "p1:o0", color: "#FF0000", opacity: .7 },
  ] }).bytes!;
  assert.match((await extractPdf(result)).pages[0]!, /^Final change/);
  assert.throws(() => executePdfium(engine, { ...q, operations: [{ type: "transform_object", id: "p1:o0", x: 1000 }] }), /outside the visible page/);
});
test("native image insertion, replacement, crop, opacity, flip and deletion create actual image objects", async () => {
  const bytes = await fixture(), pixels = { width: 2, height: 2, rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) };
  let result = executePdfium(engine, await request(bytes, [{ type: "insert_image", page: 1, pixels, x: 100, y: 100, width: 100, height: 100 }])).bytes!;
  let objects = executePdfium(engine, await request(result)).objects, image = objects.find(object => object.kind === "image")!;
  assert.deepEqual(image.rect, [100, 100, 200, 200]);
  result = (await executePdfiumTransaction(engine, await request(result, [{ type: "replace_image", id: image.id, pixels }, { type: "crop_image", id: image.id, crop: { x: .5, y: 0, width: .5, height: 1 } }, { type: "set_image_opacity", id: image.id, opacity: .5 }, { type: "set_image_opacity", id: image.id, opacity: .5 }, { type: "transform_object", id: image.id, flip: "horizontal" }]))).bytes!;
  objects = executePdfium(engine, await request(result)).objects; image = objects.find(object => object.kind === "image")!;
  assert.deepEqual(image.rect, [150, 100, 200, 200]);
  assert.deepEqual(renderPixel(result, 175, 175), [128, 255, 128, 255], "absolute half opacity survives native serialization and real raster rendering");
  result = (await executePdfiumTransaction(engine, await request(result, [{ type: "set_image_opacity", id: image.id, opacity: 0 }]))).bytes!;
  assert.deepEqual(renderPixel(result, 175, 175), [255, 255, 255, 255]);
  result = (await executePdfiumTransaction(engine, await request(result, [{ type: "set_image_opacity", id: image.id, opacity: 1 }]))).bytes!;
  assert.deepEqual(renderPixel(result, 175, 175), [0, 255, 0, 255], "opacity restores original pixels after fully transparent output");
  assert.match((await extractPdf(result)).pages[0]!, /Original source text/);
  result = executePdfium(engine, await request(result, [{ type: "delete_object", id: image.id, expectedKind: "image" }])).bytes!;
  assert.equal(executePdfium(engine, await request(result)).objects.filter(object => object.kind === "image").length, 0);
});
test("workspace headers/footer/watermarks are independently replaceable, preserve source and expose native opacity", async () => {
  let bytes = await applyPdfOperations(await fixture(), [
    { type: "set_header_footer", pages: [1, 2], header: "Review copy", footer: "Page {page} of {pages}" },
    { type: "set_watermark", pages: [1, 2], text: "DRAFT", size: 30, opacity: .2 },
  ]);
  let blocks = await listInsertedPdfText(bytes); assert.equal(blocks.length, 6); assert.equal(blocks.find(block => block.page === 2 && block.role === "footer")!.text, "Page 2 of 2");
  const native = executePdfium(engine, await request(bytes)).objects.find(object => object.text === "DRAFT")!; assert.equal(native.opacity, .2);
  bytes = await applyPdfOperations(bytes, [{ type: "set_header_footer", pages: [1], header: "Updated copy" }, { type: "set_watermark", pages: [1, 2], text: "" }]);
  blocks = await listInsertedPdfText(bytes); assert.equal(blocks.length, 4); assert.equal(blocks.filter(block => block.role === "watermark").length, 0);
  assert.equal(blocks.find(block => block.page === 2 && block.role === "header")!.text, "Review copy");
  assert.match((await extractPdf(bytes)).pages[0]!, /Original source text/);
});
test("native image crop preserves existing transparent pixel appearance", async () => {
  const bytes = await fixture();
  const inserted = (await executePdfiumTransaction(engine, await request(bytes, [{ type: "insert_image", page: 1, pixels: { width: 1, height: 1, rgba: new Uint8Array([0, 255, 0, 128]) }, x: 100, y: 100, width: 100, height: 100 }]))).bytes!;
  const image = executePdfium(engine, await request(inserted)).objects.find(object => object.kind === "image")!;
  const cropped = (await executePdfiumTransaction(engine, await request(inserted, [{ type: "crop_image", id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } }]))).bytes!;
  assert.deepEqual(renderPixel(cropped, 150, 150), renderPixel(inserted, 150, 150));
});
test("browser native worker cancellation terminates work and preserves the original input buffer", async () => {
  const bytes = await fixture(), before = bytes.slice(), abort = new AbortController(); let terminated = 0, started = 0;
  const previous = globalThis.Worker;
  class WorkerStub {
    onerror: unknown; onmessage: unknown;
    postMessage(request: PdfiumRequest) { started++; assert.notEqual(request.bytes.buffer, bytes.buffer); abort.abort(); }
    terminate() { terminated++; }
  }
  globalThis.Worker = WorkerStub as unknown as typeof Worker;
  try { await assert.rejects(runPdfium(bytes, [1], undefined, abort.signal), /cancel|abort/i); assert.equal(started, 1); assert.equal(terminated, 1); assert.deepEqual(bytes, before); }
  finally { globalThis.Worker = previous; }
});
test("inserted blocks preserve their native identity through edit/move/delete without changing source text", async () => {
  let bytes = await applyPdfOperations(await fixture(), [{ type: "insert_text", page: 1, text: "First inserted line\nSecond line", x: 50, y: 500, width: 300, font: "Courier", size: 12, color: "#0000FF" }]);
  let entries = await listInsertedPdfText(bytes); assert.equal(entries.length, 1); const id = entries[0]!.id;
  bytes = await applyPdfOperations(bytes, [{ type: "edit_inserted_text", id, text: "Changed block", x: 60, y: 450, color: "#FF0000" }]);
  entries = await listInsertedPdfText(bytes); assert.equal(entries[0]!.id, id); assert.equal(entries[0]!.text, "Changed block"); assert.equal(entries[0]!.x, 60);
  assert.ok(executePdfium(engine, await request(bytes)).objects.some(object => object.text === "Changed block"));
  bytes = await applyPdfOperations(bytes, [{ type: "delete_inserted_text", id }]);
  assert.equal((await listInsertedPdfText(bytes)).length, 0);
  assert.deepEqual((await extractPdf(bytes)).pages, (await extractPdf(await fixture())).pages);
});
test("page insert/crop/resize, extraction order and merge serialize real native page geometry", async () => {
  const source = await fixture();
  const organized = await applyPdfOperations(source, [{ type: "insert_blank_page", before: 2, width: 300, height: 400 }, { type: "set_page_size", pages: [2], width: 350, height: 450 }, { type: "crop_pages", pages: [2], box: { x: 10, y: 20, width: 300, height: 400 } }]);
  const doc = await validatePdf(organized); assert.equal(doc.getPageCount(), 3); assert.deepEqual(doc.getPage(1).getCropBox(), { x: 10, y: 20, width: 300, height: 400 });
  const extracted = await extractPdfPages(source, [2, 1]); assert.deepEqual((await extractPdf(extracted)).pages, ["Second page", "Original source text\nUnchanged evidence"]);
  const merged = await mergePdfPages(source, source, [2], 1, [1]); assert.deepEqual((await extractPdf(merged)).pages, ["Second page", "Second page"]);
  const abort = new AbortController(); abort.abort(); await assert.rejects(extractPdfPages(source, [1], abort.signal), /abort/i);
});
test("outline resolves actual page references; copying guarded linked/form structures fails closed", async () => {
  const doc = await PDFDocument.load(await fixture()), outline = doc.context.obj({ Type: "Outlines" });
  const first = doc.context.obj({ Title: PDFHexString.fromText("Second chapter"), Dest: [doc.getPage(1).ref, PDFName.of("Fit")] });
  outline.set(PDFName.of("First"), doc.context.register(first)); doc.catalog.set(PDFName.of("Outlines"), doc.context.register(outline));
  const bytes = await doc.save(); assert.deepEqual(await readPdfOutline(bytes), [{ title: "Second chapter", page: 2, children: [] }]);
  await assert.rejects(extractPdfPages(bytes, [2]), /bookmark|linked|outline/i);
});
test("markup removal is scoped to selected page/text and never deletes source or unrelated annotations", async () => {
  let bytes = await applyPdfOperations(await fixture(), [
    { type: "highlight", page: 1, rects: [[50, 690, 130, 14]] }, { type: "highlight", page: 2, rects: [[40, 390, 90, 14]] },
    { type: "add_note", page: 1, text: "Keep note", x: 30, y: 30 },
  ]), revision = 0;
  const skill = createPdfSkill({ state: () => ({ bytes, revision, storageRevision: 1, pageCount: 2, name: "test.pdf" }),
    readPage: async page => ({ page, text: "Original source text", items: [{ str: "Original source text", dir: "ltr", fontName: "Helvetica", hasEOL: false, transform: [12, 0, 0, 12, 50, 700], width: 130, height: 14 }] }),
    commit: async next => { bytes = next; revision++; } });
  const result = await skill.executeTool({ id: "remove", name: "pdf_delete_markup", input: { editRevision: 0, page: 1, text: "Original source text" } });
  assert.equal(result.isError, undefined); assert.equal(result.mutated, true);
  assert.deepEqual((await listPdfAnnotations(bytes)).annotations.map(item => [item.page, item.kind]), [[1, "Text"], [2, "Highlight"]]);
  assert.deepEqual((await extractPdf(bytes)).pages, (await extractPdf(await fixture())).pages);
});
test("extract prepares real PDF download with unchanged current bytes and truthful output, mode/revision guarded", async () => {
  const bytes = await fixture(), before = bytes.slice(); let mode: "write" | "ask" = "write"; const files: Uint8Array[] = [];
  const skill = createPdfSkill({ state: () => ({ bytes, revision: 3, storageRevision: 1, pageCount: 2, name: "test.pdf" }), readPage: async () => { throw new Error("unused"); }, commit: async () => { throw new Error("must not mutate"); }, exportFile: async (file, name) => { files.push(file); return { name }; } }, { mode: () => mode });
  const result = await skill.executeTool({ id: "extract", name: "pdf_extract_pages", input: { editRevision: 3, pages: [2], name: "exhibit" } });
  assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.output).downloaded, false); assert.match(result.summary!, /Prepared/);
  assert.deepEqual((await extractPdf(files[0]!)).pages, ["Second page"]); assert.deepEqual(bytes, before);
  mode = "ask"; assert.equal((await skill.executeTool({ id: "extract", name: "pdf_extract_pages", input: { editRevision: 3, pages: [1], name: "blocked" } })).isError, true);
  assert.equal(files.length, 1);
});

test("split reports completed file receipts when a later export fails without modifying the source", async () => {
  const bytes=await fixture(),before=bytes.slice();let created=0;
  const skill=createPdfSkill({state:()=>({bytes,revision:0,storageRevision:1,pageCount:2,name:'source.pdf'}),readPage:async()=>{throw new Error('unused');},commit:async()=>{throw new Error('must not mutate');},exportFile:async(_bytes,name)=>{if(++created===2)throw new Error('storage unavailable');return {name,docId:'completed-part',version:1,saved:true};}});
  const result=await skill.executeTool({id:'split',name:'pdf_split_document',input:{editRevision:0,parts:[{name:'first.pdf',pages:[1]},{name:'second.pdf',pages:[2]}]}});
  assert.equal(result.isError,true);const output=JSON.parse(result.output);
  assert.equal(output.files[0].docId,'completed-part');assert.equal(output.files.length,1);assert.match(output.error,/storage unavailable/);
  assert.equal(output.documentChanged,false);assert.deepEqual(bytes,before);
});

test("PDF completion verifier rejects invented downloads and unsupported exports", async () => {
  const bytes=await fixture();
  const skill=createPdfSkill({state:()=>({bytes,revision:0,storageRevision:1,pageCount:2,name:'source.pdf'}),readPage:async()=>{throw new Error('unused');},commit:async()=>{throw new Error('unused');}});
  assert.ok(skill.verifyResponse!('Extracted the file. Download: https://invented.example/file',[]));
  assert.ok(skill.verifyResponse!('Extracted page 1 and saved the copy.',[{name:'pdf_read_pages',ok:true}]));
  assert.ok(skill.verifyResponse!('Updated the requested source text.',[]));
  assert.equal(skill.verifyResponse!('Extracted page 1. File receipt: example.pdf, version 1.',[{name:'pdf_extract_pages',ok:true}]),null);
  assert.equal(skill.verifyResponse!('Unable to export: this structure is unsupported.',[]),null);
});

test("PDF extraction emits deterministic bytes without a changing creation timestamp", async () => {
  const source=await fixture();const first=await extractPdfPages(source,[2,1]);
  const parsed=await PDFDocument.load(first,{updateMetadata:false});
  assert.equal(parsed.getCreationDate(),undefined);assert.equal(parsed.getModificationDate(),undefined);
  assert.deepEqual(await extractPdfPages(source,[2,1]),first);
});
