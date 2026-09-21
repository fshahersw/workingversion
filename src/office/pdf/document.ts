import {
  PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString,
  PDFName, PDFNumber, PDFRadioGroup, PDFRawStream, PDFRef, PDFString, PDFTextField,
  StandardFonts, degrees, rgb,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { applyPageOperation, isPageOperation, type PdfPageOperation } from "./page-operations";
import { applyInsertedTextOperation, isInsertedTextOperation, type InsertedTextOperation, applyDecorationOperation, isDecorationOperation, type PdfDecorationOperation } from "./inserted-text";

export const PDF_MAX_BYTES = 30 * 1024 * 1024;
export const PDF_MAX_PAGES = 500;
const MAX_OPS = 100;
export class PdfError extends Error {
  status = 422;
}
function requirePdf(ok: unknown, message: string): asserts ok {
  if (!ok) throw new PdfError(message);
}
export function visiblePageBox(page: PDFPage) {
  const media = page.getMediaBox(), crop = page.getCropBox();
  requirePdf([crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.width > 0 && crop.height > 0,
    "The PDF contains invalid visible page geometry.");
  // PDF viewers clip CropBox to MediaBox, even when the file's CropBox is larger.
  const x = Math.max(media.x, crop.x), y = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  requirePdf(right > x && top > y, "The PDF contains an empty visible page.");
  return { x, y, width: right - x, height: top - y };
}

/** A conservative editing admission policy. Original evidence is never rewritten. */
export async function validatePdf(bytes: Uint8Array): Promise<PDFDocument> {
  requirePdf(bytes.length > 8 && bytes.length <= PDF_MAX_BYTES, "Choose a PDF up to 30 MB.");
  requirePdf(new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-", "The file is not a PDF.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  } catch {
    throw new PdfError("This PDF is damaged or encrypted. Import an unencrypted, valid PDF copy.");
  }
  requirePdf(doc.getPageCount() > 0 && doc.getPageCount() <= PDF_MAX_PAGES,
    `PDF editing supports 1–${PDF_MAX_PAGES} pages. Split larger files into volumes.`);
  for (const page of doc.getPages()) {
    const { x, y, width, height } = page.getMediaBox();
    requirePdf([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 && width <= 3600 && height <= 3600,
      "The PDF contains invalid or oversized page geometry. This workspace supports pages up to 50 inches per side.");
    visiblePageBox(page);
    const userUnit = page.node.lookupMaybe(PDFName.of("UserUnit"), PDFNumber);
    requirePdf(!userUnit || userUnit.asNumber() === 1, "Custom-scaled PDF pages require a normalized review copy.");
  }
  const forbidden = new Set(["JavaScript", "JS", "Launch", "RichMedia", "EmbeddedFiles", "EF", "XFA", "AA", "OpenAction"]);
  const seen = new Set<unknown>();
  let visited = 0;
  const visit = (value: unknown, depth = 0): void => {
    requirePdf(depth <= 100 && ++visited < 200_000, "This PDF exceeds the safe object complexity limit.");
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof PDFRawStream) return visit(value.dict, depth + 1);
    if (value instanceof PDFArray) {
      for (const item of value.asArray()) visit(item, depth + 1);
    } else if (value instanceof PDFDict) {
      const action = value.lookup(PDFName.of("S"));
      requirePdf(!(action instanceof PDFName && ["JavaScript", "Launch", "SubmitForm", "ImportData", "GoToR", "GoToE", "Rendition", "Sound", "Movie", "RichMedia"].includes(action.decodeText())),
        "This PDF contains an external or executable action. Use a flattened review copy.");
      if (action === PDFName.of("URI")) {
        const uri = value.lookup(PDFName.of("URI"));
        requirePdf((uri instanceof PDFString || uri instanceof PDFHexString) && /^(https?:|mailto:)/i.test(uri.decodeText()),
          "This PDF contains an unsupported link scheme. Use a review copy with ordinary web links.");
      }
      for (const [key, item] of value.entries()) {
        requirePdf(!forbidden.has(key.decodeText()),
          "This PDF contains scripts, actions, embedded files or XFA forms that this editor cannot safely preserve. Use a flattened review copy.");
        const resolved = doc.context.lookup(item);
        requirePdf(!(resolved instanceof PDFName && ["Sig", "DocMDP", "FieldMDP"].includes(resolved.decodeText())),
          "Digitally signed PDFs are preserved as evidence. Create an unsigned review copy before editing.");
        visit(item, depth + 1);
      }
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
  return doc;
}

export type PdfOperation =
  | PdfDecorationOperation
  | PdfPageOperation
  | InsertedTextOperation
  | { type: "rotate_pages"; pages: number[]; degrees: 90 | 180 | 270 }
  | { type: "delete_pages"; pages: number[] }
  | { type: "reorder_pages"; order: number[] }
  | { type: "add_text"; page: number; text: string; x: number; y: number; size?: number }
  | { type: "add_note"; page: number; text: string; x: number; y: number; color?: string }
  | { type: "highlight"; page: number; rects: number[][]; color?: string }
  | { type: "update_annotation"; annotationId: string; text?: string; color?: string }
  | { type: "delete_annotation"; annotationId: string }
  | { type: "fill_form"; name: string; value: string | boolean };

export type PdfAnnotation = {
  id: string; page: number; kind: string; text: string; author: string;
  rect: [number, number, number, number] | null; color?: [number, number, number];
  editable: boolean; removable: boolean; reason?: string; textTruncated?: boolean;
};
type AnnotationEntry = { id: string; page: PDFPage; pageNumber: number; raw: unknown; dict: PDFDict };
const editableAnnotationKinds = new Set(["Text", "Highlight", "Underline", "StrikeOut", "Squiggly"]);
const pdfText = (dict: PDFDict, key: string) => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
};
function annotationEntries(doc: PDFDocument): AnnotationEntry[] {
  const entries: AnnotationEntry[] = [];
  doc.getPages().forEach((page, index) => {
    for (const [at, raw] of (page.node.Annots()?.asArray() ?? []).entries()) {
      requirePdf(entries.length < 20_000, "This PDF exceeds the 20,000-annotation review limit.");
      const dict = doc.context.lookup(raw);
      if (!(dict instanceof PDFDict)) continue;
      entries.push({ id: `p${index + 1}:${raw instanceof PDFRef ? `r${raw.objectNumber}g${raw.generationNumber}` : `a${at}`}`,
        page, pageNumber: index + 1, raw, dict });
    }
  });
  return entries;
}
function annotationKind(entry: AnnotationEntry) {
  const kind = entry.dict.lookup(PDFName.of("Subtype"));
  return kind instanceof PDFName ? kind.decodeText() : "Unknown";
}
function annotationRestriction(entry: AnnotationEntry, entries: AnnotationEntry[]): string | undefined {
  if (!editableAnnotationKinds.has(annotationKind(entry))) return "Only notes and text markups can be changed here; links, widgets and other annotation types are preserved.";
  if (pdfText(entry.dict, "Contents").length > 10_000) return "This annotation exceeds the 10,000-character editing limit; its full contents are preserved.";
  if (entries.filter(other => other.dict === entry.dict).length !== 1) return "This annotation is shared by multiple page entries and cannot be edited independently.";
  const flags = entry.dict.lookup(PDFName.of("F"));
  if (flags instanceof PDFNumber && (flags.asNumber() & (64 | 128 | 512))) return "This annotation is read-only or locked.";
  if (entry.dict.has(PDFName.of("IRT")) || entries.some(other => other.dict.lookup(PDFName.of("IRT")) === entry.dict))
    return "This annotation belongs to a reply thread. Thread editing is not supported here.";
  const popup = entry.dict.lookup(PDFName.of("Popup"));
  if (popup !== undefined && (!(popup instanceof PDFDict) || !entries.some(other => other.dict === popup && other.page === entry.page &&
      annotationKind(other) === "Popup" && other.dict.lookup(PDFName.of("Parent")) === entry.dict)))
    return "This annotation has a popup relationship that requires a specialist editor.";
  if (popup instanceof PDFDict) {
    if (entries.some(other => other.dict !== entry.dict && other.dict.lookup(PDFName.of("Popup")) === popup))
      return "This annotation shares a popup with another comment; the relationship is preserved.";
    const popupFlags = popup.lookup(PDFName.of("F"));
    if (popupFlags instanceof PDFNumber && (popupFlags.asNumber() & (64 | 128 | 512))) return "This annotation's popup is read-only or locked.";
  }
  if (entries.some(other => other.dict !== popup && (other.dict.lookup(PDFName.of("Popup")) === entry.dict ||
      other.dict.lookup(PDFName.of("Parent")) === entry.dict))) return "This annotation has unsupported dependent annotations.";
  return undefined;
}
function annotationColor(value: unknown): [number, number, number] {
  requirePdf(typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value), "Use a color in #RRGGBB format.");
  return [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16) / 255) as [number, number, number];
}
/** IDs refer to the current edit revision; reread after every transaction. */
export async function listPdfAnnotations(bytes: Uint8Array, options: { page?: number; offset?: number; limit?: number } = {}) {
  const doc = await validatePdf(bytes), entries = annotationEntries(doc);
  if (options.page !== undefined) pageNumbers([options.page], doc.getPageCount());
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  requirePdf(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100, "Use an annotation offset of zero or greater and a limit of 1–100.");
  // Popup windows are the presentation of their parent, not separate comments.
  const matching = entries.filter(entry => annotationKind(entry) !== "Popup" && (options.page === undefined || entry.pageNumber === options.page));
  const candidates: PdfAnnotation[] = matching.slice(offset, offset + limit).map(entry => {
    const rawRect = entry.dict.lookup(PDFName.of("Rect")), rawColor = entry.dict.lookup(PDFName.of("C"));
    const numbers = (value: unknown) => value instanceof PDFArray ? value.asArray().map(v => {
      const n = doc.context.lookup(v); return n instanceof PDFNumber ? n.asNumber() : NaN;
    }) : [];
    const rect = numbers(rawRect), color = numbers(rawColor), content = pdfText(entry.dict, "Contents");
    const reason = annotationRestriction(entry, entries);
    return { id: entry.id, page: entry.pageNumber, kind: annotationKind(entry), text: content.slice(0, 10_000),
      author: pdfText(entry.dict, "T").slice(0, 200), rect: rect.length === 4 && rect.every(Number.isFinite) ? rect as [number, number, number, number] : null,
      ...(color.length === 3 && color.every(n => Number.isFinite(n) && n >= 0 && n <= 1) ? { color: color as [number, number, number] } : {}),
      editable: reason === undefined, removable: reason === undefined, ...(reason ? { reason } : {}),
      ...(content.length > 10_000 ? { textTruncated: true } : {}) };
  });
  const annotations: PdfAnnotation[] = [];
  let outputLength = 0;
  for (const candidate of candidates) {
    const length = JSON.stringify(candidate).length;
    if (annotations.length > 0 && outputLength + length > 40_000) break;
    annotations.push(candidate); outputLength += length;
  }
  const nextOffset = offset + annotations.length, hasMore = nextOffset < matching.length;
  return { annotations, total: matching.length, hasMore, ...(hasMore ? { nextOffset } : {}) };
}

export function pageNumbers(raw: unknown, count: number): number[] {
  requirePdf(Array.isArray(raw) && raw.length > 0 && raw.length <= PDF_MAX_PAGES, "Specify a nonempty list of page numbers.");
  requirePdf(raw.every(n => Number.isInteger(n) && n >= 1 && n <= count), `Page numbers must be between 1 and ${count}.`);
  requirePdf(new Set(raw).size === raw.length, "A page may appear only once in an operation.");
  return raw as number[];
}

export function assertPageOrganizationSupported(doc: PDFDocument) {
  const linkedStructure = ["Outlines", "Dests", "PageLabels", "StructTreeRoot"].some(name => doc.catalog.has(PDFName.of(name)));
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const hasLinks = doc.getPages().some(page => {
    const annots = page.node.Annots();
    return annots?.asArray().some(ref => {
      const annot = doc.context.lookup(ref);
      return annot instanceof PDFDict && annot.lookup(PDFName.of("Subtype")) === PDFName.of("Link");
    });
  });
  requirePdf(!linkedStructure && !names?.has(PDFName.of("Dests")) && !hasLinks,
    "Page deletion or reordering is unavailable for PDFs with bookmarks, links, page labels or accessibility structure. Those references need a specialist editor to preserve them.");
}

export async function listPdfFields(bytes: Uint8Array) {
  const doc = await validatePdf(bytes);
  return doc.getForm().getFields().map(field => ({
    name: field.getName(),
    readOnly: field.isReadOnly(),
    type: field instanceof PDFTextField ? "text" : field instanceof PDFCheckBox ? "checkbox" :
      field instanceof PDFDropdown ? "dropdown" : field instanceof PDFRadioGroup ? "radio" : "unsupported",
    value: field instanceof PDFTextField ? field.getText() ?? "" : field instanceof PDFCheckBox ? field.isChecked() :
      field instanceof PDFDropdown ? field.getSelected() : field instanceof PDFRadioGroup ? field.getSelected() : null,
    options: field instanceof PDFDropdown || field instanceof PDFRadioGroup ? field.getOptions() : undefined,
  }));
}

/** Always changes a detached copy. A rejected operation cannot partly alter the caller's bytes. */
export async function applyPdfOperations(bytes: Uint8Array, operations: PdfOperation[], signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  requirePdf(Array.isArray(operations) && operations.length > 0 && operations.length <= MAX_OPS, "Use 1–100 PDF operations per transaction.");
  const doc = await validatePdf(bytes);
  const originalAnnotations = annotationEntries(doc);
  let formChanged = false;
  for (const op of operations) {
    signal?.throwIfAborted();
    requirePdf(op && typeof op === "object", "Invalid PDF operation.");
    if (isPageOperation(op)) { applyPageOperation(doc, op); continue; }
    if (isInsertedTextOperation(op)) { await applyInsertedTextOperation(doc, op); continue; }
    if (isDecorationOperation(op)) { await applyDecorationOperation(doc, op); continue; }
    requirePdf(["rotate_pages", "delete_pages", "reorder_pages", "add_text", "add_note", "highlight", "fill_form", "update_annotation", "delete_annotation"].includes(op.type),
      "Invalid operation type: " + String(op.type).slice(0, 50) + ". Set type to rotate_pages, delete_pages, reorder_pages, add_text, add_note, fill_form, update_annotation or delete_annotation. Use pdf_highlight_text for highlights.");
    if (op.type === "update_annotation" || op.type === "delete_annotation") {
      requirePdf(typeof op.annotationId === "string" && op.annotationId.length <= 80, "Use an annotationId returned by pdf_list_annotations.");
      const entry = originalAnnotations.find(item => item.id === op.annotationId);
      requirePdf(entry && doc.getPages().includes(entry.page) && entry.page.node.Annots()?.asArray().some(raw => doc.context.lookup(raw) === entry.dict), "This annotation is missing. List the current annotations again.");
      const restriction = annotationRestriction(entry, annotationEntries(doc));
      requirePdf(!restriction, restriction ?? "This annotation cannot be changed.");
      if (op.type === "delete_annotation") {
        const popup = entry.dict.lookup(PDFName.of("Popup")), annots = entry.page.node.Annots()!;
        for (let i = annots.size() - 1; i >= 0; i--) {
          const dict = doc.context.lookup(annots.get(i));
          if (dict === entry.dict || dict === popup) annots.remove(i);
        }
      } else {
        requirePdf(op.text !== undefined || op.color !== undefined, "An annotation update needs text or color.");
        if (op.text !== undefined) {
          requirePdf(typeof op.text === "string" && op.text.length <= 10_000, "Annotation text must be at most 10,000 characters.");
          entry.dict.set(PDFName.of("Contents"), PDFHexString.fromText(op.text));
          entry.dict.delete(PDFName.of("RC")); // Plain text is now authoritative, not a stale rich-text body.
        }
        if (op.color !== undefined) {
          entry.dict.set(PDFName.of("C"), doc.context.obj(annotationColor(op.color)));
          entry.dict.delete(PDFName.of("AP")); // Regenerate standard annotation appearance using its new color.
        }
      }
      continue;
    }
    if (op.type === "fill_form") {
      requirePdf(typeof op.name === "string" && op.name.length > 0, "A form field name is required.");
      const field = doc.getForm().getFieldMaybe(op.name);
      requirePdf(field && !field.isReadOnly(), "The form field is missing or read-only.");
      if (field instanceof PDFCheckBox) {
        requirePdf(typeof op.value === "boolean", "Checkbox values must be true or false.");
        if (op.value) field.check(); else field.uncheck();
      } else {
        requirePdf(typeof op.value === "string" && op.value.length <= 10_000, "Use a text form value up to 10,000 characters.");
        if (field instanceof PDFTextField) field.setText(op.value);
        else if (field instanceof PDFDropdown || field instanceof PDFRadioGroup) {
          requirePdf(field.getOptions().includes(op.value), "Select a listed form option.");
          field.select(op.value);
        } else throw new PdfError("This form field type is not editable here.");
      }
      formChanged = true;
      continue;
    }
    if (op.type === "rotate_pages" || op.type === "delete_pages") {
      const pages = pageNumbers(op.pages, doc.getPageCount());
      if (op.type === "rotate_pages") {
        requirePdf([90, 180, 270].includes(op.degrees), "Rotation must be 90, 180 or 270 degrees.");
        for (const n of pages) {
          const page = doc.getPage(n - 1);
          page.setRotation(degrees((page.getRotation().angle + op.degrees) % 360));
        }
      } else {
        assertPageOrganizationSupported(doc);
        requirePdf(pages.length < doc.getPageCount(), "Keep at least one PDF page.");
        requirePdf(doc.getForm().getFields().length === 0, "Page deletion is unavailable for PDFs with form fields; use a separate flattened copy.");
        for (const n of pages.sort((a, b) => b - a)) doc.removePage(n - 1);
      }
      continue;
    }
    if (op.type === "reorder_pages") {
      assertPageOrganizationSupported(doc);
      const order = pageNumbers(op.order, doc.getPageCount());
      requirePdf(order.length === doc.getPageCount(), "The page order must include every page exactly once.");
      const pages = doc.getPages();
      // Reparenting leaves would otherwise replace their inherited fonts and geometry.
      for (const page of pages) {
        for (const name of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
          const key = PDFName.of(name);
          const value = page.node.getInheritableAttribute(key);
          if (value) page.node.set(key, value);
        }
      }
      for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
      for (const n of order) doc.addPage(pages[n - 1]!);
      continue;
    }
    requirePdf(["add_text", "add_note", "highlight"].includes(op.type), "This PDF operation type is unsupported. Use the documented operation types; source text/image edits use pdf_edit_page_objects.");
    const target = op as Extract<PdfOperation, { page: number }>;
    const n = pageNumbers([target.page], doc.getPageCount())[0]!;
    const page = doc.getPage(n - 1);
    const { x: left, y: bottom, width, height } = visiblePageBox(page);
    const right = left + width, top = bottom + height;
    if (target.type === "highlight") {
      requirePdf(Array.isArray(target.rects) && target.rects.length > 0 && target.rects.length <= 200, "Select 1–200 text rectangles.");
      for (const rect of target.rects) {
        requirePdf(Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite), "Invalid highlight coordinates.");
        const [x, y, w, h] = rect as [number, number, number, number];
        requirePdf(w > 0 && h > 0 && x >= left && y >= bottom && x + w <= right + 1 && y + h <= top + 1, "The highlight falls outside the visible page.");
        const annot = doc.context.obj({ Type: "Annot", Subtype: "Highlight", Rect: [x, y, x + w, y + h],
          QuadPoints: [x, y + h, x + w, y + h, x, y, x + w, y], C: target.color === undefined ? [1, 0.85, 0] : annotationColor(target.color), CA: 0.35,
          T: PDFString.of("AI Assistant"), F: 4 });
        page.node.addAnnot(doc.context.register(annot));
      }
    } else {
      requirePdf(typeof target.text === "string" && target.text.trim().length > 0 && target.text.length <= 10_000, "Text must contain 1–10,000 characters.");
      requirePdf(Number.isFinite(target.x) && Number.isFinite(target.y) && target.x >= left && target.y >= bottom && target.x < right && target.y < top, "Position must be inside the visible page in PDF points.");
      if (target.type === "add_note") {
        const annotation = doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [target.x, target.y, Math.min(right, target.x + 20), Math.min(top, target.y + 20)],
          Contents: PDFHexString.fromText(target.text), T: PDFString.of("AI Assistant"), Name: "Comment", C: target.color === undefined ? [1, 0.85, 0] : annotationColor(target.color), F: 4 });
        page.node.addAnnot(doc.context.register(annotation));
      } else {
        const size = target.size ?? 12;
        requirePdf(Number.isFinite(size) && size >= 6 && size <= 72, "Font size must be between 6 and 72 points.");
        const font = await doc.embedFont(StandardFonts.Helvetica);
        try {
          font.encodeText(target.text);
          requirePdf(!/[\r\n]/.test(target.text), "Add one line per operation so its placement can be verified.");
          requirePdf(target.x + font.widthOfTextAtSize(target.text, size) <= right && target.y >= bottom + size * 0.25 && target.y + size <= top, "The text would overflow the visible page. Shorten it, reduce its size or adjust its position.");
          page.drawText(target.text, { x: target.x, y: target.y, size, font, color: rgb(0.08, 0.12, 0.2) });
        } catch (error) {
          if (error instanceof PdfError) throw error;
          throw new PdfError("This font cannot represent the requested text. Use a Word document for multilingual authoring.");
        }
      }
    }
  }
  try {
    signal?.throwIfAborted();
    if (formChanged) doc.getForm().updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
    const output = await doc.save({ updateFieldAppearances: false });
    await validatePdf(output);
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PdfError) throw error;
    throw new PdfError("The requested form text cannot be encoded with the supported font. No changes were applied.");
  }
}

export async function createBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}
