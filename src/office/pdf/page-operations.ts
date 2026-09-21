import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { assertPageOrganizationSupported, pageNumbers, PDF_MAX_PAGES, validatePdf } from "./document";

export type PdfPageOperation =
  | { type: "insert_blank_page"; before: number; width?: number; height?: number }
  | { type: "set_page_size"; pages: number[]; width: number; height: number }
  | { type: "crop_pages"; pages: number[]; box: { x: number; y: number; width: number; height: number } };
export function isPageOperation(value: { type: string }): value is PdfPageOperation {
  return ["insert_blank_page", "set_page_size", "crop_pages"].includes(value.type);
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function dimensions(width: unknown, height: unknown): asserts width is number {
  assert(typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) &&
    width >= 36 && height >= 36 && width <= 3600 && height <= 3600, "Page dimensions must be 36–3600 PDF points per side.");
}
export function applyPageOperation(doc: PDFDocument, operation: PdfPageOperation) {
  if (operation.type === "insert_blank_page") {
    assertPageOrganizationSupported(doc);
    const width = operation.width ?? 612, height = operation.height ?? 792;
    dimensions(width, height);
    assert(Number.isInteger(operation.before) && operation.before >= 1 && operation.before <= doc.getPageCount() + 1, "before must be a current page number or pageCount+1 to append.");
    assert(doc.getPageCount() < PDF_MAX_PAGES, "This document already has the maximum 500 pages.");
    doc.insertPage(operation.before - 1, [width, height]);
    return;
  }
  for (const number of pageNumbers(operation.pages, doc.getPageCount())) {
    const page = doc.getPage(number - 1), media = page.getMediaBox();
    if (operation.type === "set_page_size") {
      dimensions(operation.width, operation.height);
      // Explicit canvas resizing, not a hidden content transform or destructive crop.
      page.setMediaBox(media.x, media.y, operation.width, operation.height);
      page.setCropBox(media.x, media.y, operation.width, operation.height);
    } else {
      const box = operation.box;
      assert(box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0 &&
        box.x >= media.x && box.y >= media.y && box.x + box.width <= media.x + media.width && box.y + box.height <= media.y + media.height,
      "Crop coordinates must define a positive rectangle inside each page's MediaBox. Cropping hides content; it never redacts it.");
      page.setCropBox(box.x, box.y, box.width, box.height);
    }
  }
}
function requirePortablePages(doc: PDFDocument) {
  assertPageOrganizationSupported(doc);
  assert(doc.getForm().getFields().length === 0, "Copying/extracting pages with form fields requires a flattened copy so field names and widgets are not lost.");
}
export async function extractPdfPages(bytes: Uint8Array, pages: number[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = await validatePdf(bytes); requirePortablePages(source);
  // Stable derivative bytes let the export receipt survive a later retry. A
  // fresh wall-clock CreationDate would otherwise produce a duplicate file.
  const chosen = pageNumbers(pages, source.getPageCount()), result = await PDFDocument.create({ updateMetadata: false });
  for (const page of await result.copyPages(source, chosen.map(n => n - 1))) result.addPage(page);
  signal?.throwIfAborted();
  const output = await result.save({ updateFieldAppearances: false }); await validatePdf(output); signal?.throwIfAborted(); return output;
}
export async function mergePdfPages(bytes: Uint8Array, sourceBytes: Uint8Array, pages: number[], before: number, replace: number[] = [], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const target = await validatePdf(bytes), source = await validatePdf(sourceBytes);
  assertPageOrganizationSupported(target); requirePortablePages(source);
  assert(Number.isInteger(before) && before >= 1 && before <= target.getPageCount() + 1, "Insertion position must be a current page or pageCount+1.");
  const chosen = pageNumbers(pages, source.getPageCount()), removed = replace.length ? pageNumbers(replace, target.getPageCount()) : [];
  if (removed.length) assert(target.getForm().getFields().length === 0, "Replacing form pages requires a separate flattened copy.");
  assert(target.getPageCount() - removed.length + chosen.length <= PDF_MAX_PAGES, "The merged document would exceed 500 pages.");
  const insertion = before - 1 - removed.filter(n => n < before).length;
  for (const n of removed.sort((a, b) => b - a)) target.removePage(n - 1);
  const copies = await target.copyPages(source, chosen.map(n => n - 1));
  copies.forEach((page, index) => target.insertPage(insertion + index, page));
  signal?.throwIfAborted();
  const output = await target.save({ updateFieldAppearances: false }); await validatePdf(output); signal?.throwIfAborted(); return output;
}
export type PdfOutlineItem = { title: string; page: number | null; children: PdfOutlineItem[] };
export async function readPdfOutline(bytes: Uint8Array): Promise<PdfOutlineItem[]> {
  const doc = await validatePdf(bytes), seen = new Set<PDFDict>(), named = new Map<string, unknown>();
  const string = (v: unknown) => v instanceof PDFName ? v.decodeText() : v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  let visited = 0, titleBudget = 0;
  const loadNames = (node: PDFDict, depth: number) => {
    assert(depth < 32 && ++visited < 5000, "PDF destination tree exceeds the bounded outline limit.");
    const pairs = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (pairs) for (let i = 0; i + 1 < pairs.size(); i += 2) { const key = string(doc.context.lookup(pairs.get(i))); if (key) named.set(key, doc.context.lookup(pairs.get(i + 1))); }
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids) for (const kid of kids.asArray()) { const child = doc.context.lookup(kid); if (child instanceof PDFDict) loadNames(child, depth + 1); }
  };
  if (names) loadNames(names, 0);
  const dests = doc.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (dests) for (const [key, value] of dests.entries()) named.set(key.decodeText(), doc.context.lookup(value));
  const pageFor = (raw: unknown) => {
    let destination = doc.context.lookup(raw as never);
    const key = string(destination); if (key) destination = named.get(key) as never;
    if (destination instanceof PDFDict) destination = destination.lookup(PDFName.of("D"));
    if (!(destination instanceof PDFArray)) return null;
    const first = destination.get(0), resolved = doc.context.lookup(first);
    if (resolved instanceof PDFNumber) { const n = resolved.asNumber(); return Number.isInteger(n) && n >= 0 && n < doc.getPageCount() ? n + 1 : null; }
    const at = doc.getPages().findIndex(page => page.node === resolved); return at < 0 ? null : at + 1;
  };
  const walk = (first: unknown, depth: number): PdfOutlineItem[] => {
    const items: PdfOutlineItem[] = []; let item = doc.context.lookup(first as never);
    while (item instanceof PDFDict) {
      assert(depth < 32 && !seen.has(item) && seen.size < 1000, "PDF outline is cyclic or exceeds the bounded review limit."); seen.add(item);
      const action = item.lookupMaybe(PDFName.of("A"), PDFDict), dest = item.get(PDFName.of("Dest")) ?? (action?.lookup(PDFName.of("S")) === PDFName.of("GoTo") ? action.get(PDFName.of("D")) : undefined);
      const title = (string(item.lookup(PDFName.of("Title"))) ?? "Untitled").slice(0, 500);
      titleBudget += title.length; assert(titleBudget <= 32_000, "PDF bookmark text exceeds the bounded outline output budget.");
      items.push({ title, page: dest === undefined ? null : pageFor(dest), children: walk(item.get(PDFName.of("First")), depth + 1) });
      item = item.lookup(PDFName.of("Next"));
    }
    return items;
  };
  return walk(doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict)?.get(PDFName.of("First")), 0);
}
