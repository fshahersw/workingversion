import type { AgentToolDef, ToolExecution } from "@genoffice/agent-core";
import type { PdfAgentAccess } from "./skill";
import { applyPdfOperations, listPdfAnnotations } from "./document";
import { extractPdfPages, mergePdfPages, readPdfOutline } from "./page-operations";
import { listInsertedPdfText } from "./inserted-text";
import { highlightRects } from "./reader";
import { runPdfium } from "./pdfium-client";
import type { PdfNativeEdit } from "./pdfium-core";
import type { PdfNativeImageEdit } from "./pdfium-core";
import { decodePdfImage } from "./image-source";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const page = { type: "integer", minimum: 1, maximum: 500 };
const pages = { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: page };
const editRevision = { type: "integer", minimum: 0 };
const id = { type: "string", minLength: 1, maxLength: 100 };
const coordinate = { type: "number" };
const text = { type: "string", maxLength: 10_000 };
const color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const positive = { type: "number", exclusiveMinimum: 0, maximum: 3600 };
const op = (type: string, properties: Record<string, unknown>, required: string[]) => schema({ type: { type: "string", enum: [type] }, ...properties }, ["type", ...required]);
export const EXTRA_PDF_OPERATION_SCHEMAS = [
  op("set_header_footer", { pages, header: { type: "string", maxLength: 1000 }, footer: { type: "string", maxLength: 1000 }, size: { type: "number", minimum: 6, maximum: 72 }, margin: positive, color }, ["pages"]),
  op("set_watermark", { pages, text: { type: "string", maxLength: 1000 }, size: { type: "number", minimum: 6, maximum: 72 }, opacity: { type: "number", minimum: 0, maximum: 1 }, color }, ["pages", "text"]),
  op("insert_blank_page", { before: { type: "integer", minimum: 1, maximum: 501 }, width: positive, height: positive }, ["before"]),
  op("set_page_size", { pages, width: positive, height: positive }, ["pages", "width", "height"]),
  op("crop_pages", { pages, box: schema({ x: coordinate, y: coordinate, width: positive, height: positive }, ["x", "y", "width", "height"]) }, ["pages", "box"]),
  op("insert_text", { page, text, x: coordinate, y: coordinate, size: { type: "number", minimum: 6, maximum: 72 }, color, font: { type: "string", enum: ["Helvetica", "Times-Roman", "Courier"] }, width: positive }, ["page", "text", "x", "y"]),
  op("edit_inserted_text", { id, text, x: coordinate, y: coordinate, size: { type: "number", minimum: 6, maximum: 72 }, color, width: positive }, ["id"]),
  op("delete_inserted_text", { id }, ["id"]),
];
const nativeOperations = [
  op("replace_text", { id, expectedText: text, text }, ["id", "expectedText", "text"]),
  op("delete_object", { id, expectedKind: { type: "string", enum: ["text", "image"] } }, ["id", "expectedKind"]),
  op("transform_object", { id, x: coordinate, y: coordinate, width: positive, height: positive, rotate: { type: "integer", enum: [90, 180, 270] }, flip: { type: "string", enum: ["horizontal", "vertical"] } }, ["id"]),
  op("set_object_color", { id, color, opacity: { type: "number", minimum: 0, maximum: 1 } }, ["id", "color"]),
  op("insert_image", { page, sourceId: id, x: coordinate, y: coordinate, width: positive, height: positive }, ["page", "sourceId", "x", "y", "width", "height"]),
  op("replace_image", { id, sourceId: id }, ["id", "sourceId"]),
  op("crop_image", { id, crop: schema({ x: coordinate, y: coordinate, width: positive, height: positive }, ["x", "y", "width", "height"]) }, ["id", "crop"]),
  op("set_image_opacity", { id, opacity: { type: "number", minimum: 0, maximum: 1 } }, ["id", "opacity"]),
];
export const EXTRA_PDF_TOOLS: AgentToolDef[] = [
  { name: "pdf_goto_page", readOnly: true, description: "Navigate the visible PDF to a current physical page. This changes navigation only, not the file.", inputSchema: schema({ page }, ["page"]) },
  { name: "pdf_get_outline", readOnly: true, description: "Read the real PDF bookmark tree and resolved physical page destinations. A missing outline does not mean the document lacks sections.", inputSchema: schema({}) },
  { name: "pdf_list_sources", readOnly: true, description: "List user-attached local PDF/image sources. Use only returned source ids; files are local to this open workspace.", inputSchema: schema({}) },
  { name: "pdf_list_inserted_text", readOnly: true, description: "Read text blocks inserted by this workspace, with stable block ids and their actual placement/style. Edits to source text use page objects instead.", inputSchema: schema({ page }) },
  { name: "pdf_list_page_objects", readOnly: true, description: "Inspect actual top-level native PDF text/image objects, exact source text, bounds, font and ephemeral ids for source editing. Nested forms/paths are preserved, not editable. Read at most five pages. Output is paginated; IDs require the current edit revision.", inputSchema: schema({ pages: { ...pages, maxItems: 5 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["pages"]) },
  { name: "pdf_edit_page_objects", description: "Atomically modify actual native PDF source objects using current ids. replace_text requires exact expectedText and supported glyphs in the original font; an empty replacement removes that text object. delete_object removes only the selected text/image object. Transforms use bottom-left PDF points and explicit width/height (independent scaling). insert_image/replace_image use attached PNG/JPEG sourceIds. crop_image uses fractional top-left source-image coordinates and rasterizes only that image at its source pixel dimensions. set_image_opacity sets absolute object alpha, preserving its image pixels. Rendering and original glyph support must be verified. This is NOT certified redaction: history, metadata and other objects may retain information. Capture before and after, then reread new ids. No overlays are used to pretend to replace text.", inputSchema: schema({ editRevision, pages: { ...pages, maxItems: 5 }, operations: { type: "array", minItems: 1, maxItems: 50, items: { anyOf: nativeOperations } } }, ["editRevision", "pages", "operations"]) },
  { name: "pdf_delete_markup", description: "Remove existing text markups only on one explicitly scoped page. Use either exact annotation ids or a unique exact quote to target overlapping Highlight/Underline/StrikeOut/Squiggly annotations. This never deletes page text, images or notes. For 'remove highlights' scope the user's current page/selection; do not remove unrelated content.", inputSchema: schema({ editRevision, page, annotationIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: id }, text: { type: "string", minLength: 1, maxLength: 10_000 }, allOnPage: { type: "boolean" } }, ["editRevision", "page"]) },
  { name: "pdf_merge_pages", description: "Insert selected pages from an attached local PDF before a current page (pageCount+1 appends). Optional replacePages removes exactly those destination pages. Linked/tagged/field structures that cannot be preserved are rejected before mutation. The source is unchanged.", inputSchema: schema({ editRevision, sourceId: id, pages, before: { type: "integer", minimum: 1, maximum: 501 }, replacePages: pages }, ["editRevision", "sourceId", "pages", "before"]) },
  { name: "pdf_extract_pages", description: "Save a separate native PDF in the Library containing selected pages in the requested order, then prepare its authenticated download link. The current document is unchanged. Browser download completion cannot be confirmed by this tool. Linked/tagged/form PDFs are rejected where copying would break structures.", inputSchema: schema({ editRevision, pages, name: { type: "string", minLength: 1, maxLength: 160 } }, ["editRevision", "pages", "name"]) },
  { name: "pdf_split_document", description: "Save up to three separate native PDFs in the Library from explicit page groups, then prepare authenticated download links. All groups are validated and built before file creation. Completed files are reported if a later creation fails and reused on the same retry. The current document is unchanged. Name every output; distinguish Library save from browser download completion.", inputSchema: schema({ editRevision, parts: { type: "array", minItems: 1, maxItems: 3, items: schema({ pages, name: { type: "string", minLength: 1, maxLength: 160 } }, ["pages", "name"]) } }, ["editRevision", "parts"]) },
];
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function fileName(value: unknown) {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\\/<>:"|?*\x00-\x1f]/.test(value), "Choose a simple PDF filename without a path.");
  return value.toLowerCase().endsWith(".pdf") ? value : value + ".pdf";
}
function pageScope(value: unknown, count: number, maximum = 500): number[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum && new Set(value).size === value.length && value.every(n => Number.isInteger(n) && n >= 1 && n <= count), "Provide distinct valid current page numbers within the tool's page limit.");
  return value;
}
export async function executeExtendedPdfTool(access: PdfAgentAccess, name: string, input: Record<string, unknown>, assertCurrent: () => void, assertWrite: () => void, signal?: AbortSignal): Promise<ToolExecution | undefined> {
  if (!EXTRA_PDF_TOOLS.some(tool => tool.name === name)) return;
  const state = access.state(), versions = { editRevision: state.revision, storageRevision: state.storageRevision };
  const read = (summary: string, value: unknown): ToolExecution => { assertCurrent(); return { summary, output: JSON.stringify({ ...versions, ...value as object }) }; };
  const commit = async (bytes: Uint8Array, summary: string) => {
    assertCurrent(); assertWrite(); await access.commit(bytes, state.revision, summary, signal);
    return { mutated: true, summary, output: JSON.stringify({ editRevision: access.state().revision, storageRevision: access.state().storageRevision, saved: false, undoAvailable: true }) };
  };
  if (name === "pdf_goto_page") { requireValue(access.navigate, "PDF navigation is unavailable."); const chosen = pageScope([input.page], state.pageCount)[0]!; assertCurrent(); access.navigate(chosen); return read("Opened page " + chosen, { page: chosen }); }
  if (name === "pdf_get_outline") return read("Read PDF bookmarks", { outline: await readPdfOutline(state.bytes) });
  if (name === "pdf_list_sources") return read("Read attached sources", { sources: access.sources?.() ?? [] });
  if (name === "pdf_list_inserted_text") {
    const blocks = await listInsertedPdfText(state.bytes, input.page as number | undefined);
    requireValue(JSON.stringify(blocks).length <= 40_000, "Inserted text exceeds the output budget. Read one page at a time.");
    return read("Read " + blocks.length + " inserted text blocks", { blocks });
  }
  if (name === "pdf_list_page_objects") {
    const chosen = pageScope(input.pages, state.pageCount, 5), offset = input.offset ?? 0, limit = input.limit ?? 100;
    requireValue(Number.isInteger(offset) && Number(offset) >= 0 && Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 100, "Invalid native object pagination.");
    const { objects } = await runPdfium(state.bytes, chosen, undefined, signal), output = [];
    let size = 0;
    for (const object of objects.slice(Number(offset), Number(offset) + Number(limit))) { const length = JSON.stringify(object).length; if (size + length > 40_000) break; output.push(object); size += length; }
    const nextOffset = Number(offset) + output.length;
    return read("Read " + output.length + " native page objects", { objects: output, total: objects.length, hasMore: nextOffset < objects.length, ...(nextOffset < objects.length ? { nextOffset } : {}) });
  }
  requireValue(input.editRevision === state.revision, "The editRevision token is missing or stale. Reread the current document.");
  assertWrite();
  if (name === "pdf_edit_page_objects") {
    const chosen = pageScope(input.pages, state.pageCount, 5);
    requireValue(Array.isArray(input.operations), "Provide native object operations.");
    requireValue(input.operations.length > 0 && input.operations.length <= 50, "Provide 1–50 native operations.");
    const operations: Array<PdfNativeEdit | PdfNativeImageEdit> = []; let decodedBytes = 0;
    for (const operation of input.operations) {
      requireValue(operation && typeof operation === "object", "Each native operation needs a type.");
      if (operation.type === "insert_image" || operation.type === "replace_image") {
        const source = access.sources?.().find(source => source.id === operation.sourceId);
        requireValue(source?.kind === "image" && access.sourceBytes, "Use an attached PNG/JPEG image source id.");
        const pixels = await decodePdfImage(await access.sourceBytes(source.id), signal); assertCurrent(); decodedBytes += pixels.rgba.length;
        requireValue(decodedBytes <= 64 * 1024 * 1024, "This batch exceeds 64 MB of decoded images. Use smaller image batches.");
        const { sourceId: _, ...rest } = operation; operations.push({ ...rest, pixels } as PdfNativeImageEdit);
      } else operations.push(operation as PdfNativeEdit | PdfNativeImageEdit);
    }
    const result = await runPdfium(state.bytes, chosen, operations, signal);
    requireValue(result.bytes, "No native document was generated.");
    return commit(result.bytes, "Edited " + input.operations.length + " native PDF object(s)");
  }
  if (name === "pdf_delete_markup") {
    const chosen = pageScope([input.page], state.pageCount)[0]!;
    const selectors = Number(input.annotationIds !== undefined) + Number(input.text !== undefined) + Number(input.allOnPage === true);
    requireValue(selectors === 1, "Choose exactly one markup selector: annotationIds, exact text, or allOnPage:true.");
    const all = [];
    let offset = 0;
    do { const result = await listPdfAnnotations(state.bytes, { page: chosen, offset, limit: 100 }); all.push(...result.annotations); if (!result.hasMore) break; offset = result.nextOffset!; requireValue(all.length <= 1000, "This page exceeds the markup removal budget; use explicit ids."); } while (true);
    let selected = all.filter(annotation => ["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(annotation.kind));
    if (input.annotationIds !== undefined) {
      requireValue(Array.isArray(input.annotationIds) && input.annotationIds.length > 0 && input.annotationIds.length <= 100 && input.annotationIds.every(id => typeof id === "string"), "Provide 1–100 annotation ids.");
      const ids = new Set(input.annotationIds); selected = selected.filter(item => ids.has(item.id));
      requireValue(selected.length === ids.size, "Every requested id must be a text markup on the specified page. Notes and source objects are never removed by this tool.");
    } else if (input.text !== undefined) {
      requireValue(typeof input.text === "string" && input.text.length > 0, "An exact selected quote is required.");
      const rects = highlightRects(await access.readPage(chosen), input.text); assertCurrent();
      selected = selected.filter(annotation => annotation.rect && rects.some(rect => Math.min(annotation.rect![2]!, rect[0]! + rect[2]!) > Math.max(annotation.rect![0]!, rect[0]!) && Math.min(annotation.rect![3]!, rect[1]! + rect[3]!) > Math.max(annotation.rect![1]!, rect[1]!)));
    }
    requireValue(selected.length > 0, "No matching text markups were found; source content was not changed.");
    requireValue(selected.length <= 100 && selected.every(item => item.removable), "The selected markups include protected structures or exceed 100 annotations. Inspect their restrictions first.");
    return commit(await applyPdfOperations(state.bytes, selected.map(item => ({ type: "delete_annotation", annotationId: item.id })), signal), "Removed " + selected.length + " text markup(s); source content preserved");
  }
  if (name === "pdf_merge_pages") {
    const source = access.sources?.().find(source => source.id === input.sourceId);
    requireValue(source?.kind === "pdf" && access.sourceBytes, "Choose an attached PDF source id.");
    const bytes = await access.sourceBytes(source.id); assertCurrent();
    return commit(await mergePdfPages(state.bytes, bytes, input.pages as number[], Number(input.before), (input.replacePages ?? []) as number[], signal), "Merged selected source PDF pages");
  }
  requireValue(access.exportFile, "PDF download preparation is unavailable.");
  const parts = name === "pdf_extract_pages" ? [{ pages: input.pages, name: input.name }] : input.parts;
  requireValue(Array.isArray(parts) && parts.length > 0 && parts.length <= 10, "Provide 1–10 PDF output parts.");
  const prepared: Array<{ bytes: Uint8Array; name: string }> = []; let total = 0;
  for (const part of parts) {
    requireValue(part && typeof part === "object", "Each output needs pages and a filename.");
    const bytes = await extractPdfPages(state.bytes, part.pages, signal), name = fileName(part.name);
    assertCurrent(); total += bytes.length; requireValue(total <= 30 * 1024 * 1024, "Combined split output exceeds 30 MB. Prepare fewer parts."); prepared.push({ bytes, name });
  }
  assertCurrent(); assertWrite();
  const files = [];
  try {
    for (const part of prepared) { signal?.throwIfAborted(); files.push(await access.exportFile(part.bytes, part.name, signal)); }
  } catch (error) {
    return { isError: true, summary: "PDF export interrupted", output: JSON.stringify({ error: error instanceof Error ? error.message : String(error), files, downloaded: false, documentChanged: false, retry: "Retry the same names and page groups in this workspace; completed exports are reused." }) };
  }
  return read("Prepared " + files.length + " PDF download offer(s)", { files, downloaded: false, documentChanged: false });
}
