import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts } from "pdf-lib";
import { pageNumbers, validatePdf, visiblePageBox } from "./document";

export type InsertedText = { id: string; page: number; text: string; x: number; y: number; size: number; color: string; font: "Helvetica" | "Times-Roman" | "Courier"; width?: number; opacity?: number; role?: "header" | "footer" | "watermark" };
export type InsertedTextOperation =
  | { type: "insert_text"; page: number; text: string; x: number; y: number; size?: number; color?: string; font?: InsertedText["font"]; width?: number; opacity?: number; role?: InsertedText["role"] }
  | { type: "edit_inserted_text"; id: string; text?: string; size?: number; color?: string; x?: number; y?: number; width?: number; opacity?: number }
  | { type: "delete_inserted_text"; id: string };
const key = PDFName.of("SWInsertedText"), formatKey = PDFName.of("SWTextFormat");
function fail(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function isInsertedTextOperation(value: { type: string }): value is InsertedTextOperation { return ["insert_text", "edit_inserted_text", "delete_inserted_text"].includes(value.type); }
function records(doc: PDFDocument) {
  const output: Array<{ data: InsertedText; stream: PDFRef; dict: PDFDict; entries: PDFArray; index: number }> = [];
  for (const [number, page] of doc.getPages().entries()) {
    const entries = page.node.lookupMaybe(key, PDFArray); if (!entries) continue;
    const contents = page.node.Contents(), refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))];
    for (let index = 0; index < entries.size(); index++) {
      fail(output.length < 1000, "Inserted-text inventory exceeds 1000 blocks.");
      const dict = entries.lookup(index); if (!(dict instanceof PDFDict)) continue;
      const value = dict.lookup(formatKey), stream = dict.get(PDFName.of("Stream"));
      if (!(value instanceof PDFHexString) || !(stream instanceof PDFRef) || !refs.some(ref => ref === stream)) continue;
      try {
        const data = JSON.parse(value.decodeText()) as InsertedText;
        if (typeof data.id !== "string" || typeof data.text !== "string" || data.text.length > 10_000 || ![data.x, data.y, data.size].every(Number.isFinite)) continue;
        output.push({ data: { ...data, page: number + 1 }, stream, dict, entries, index });
      } catch { /* Preserve malformed imported metadata rather than treating it as an editable object. */ }
    }
  }
  return output;
}
export async function listInsertedPdfText(bytes: Uint8Array, page?: number) {
  const doc = await validatePdf(bytes); if (page !== undefined) pageNumbers([page], doc.getPageCount());
  return records(doc).filter(entry => page === undefined || entry.data.page === page).map(entry => entry.data);
}
async function content(doc: PDFDocument, data: InsertedText) {
  fail(typeof data.text === "string" && data.text.trim().length > 0 && data.text.length <= 10_000, "Inserted text must contain 1–10,000 characters.");
  fail(Number.isFinite(data.size) && data.size >= 6 && data.size <= 72, "Font size must be 6–72 points.");
  fail(["Helvetica", "Times-Roman", "Courier"].includes(data.font), "Choose Helvetica, Times-Roman or Courier.");
  fail(/^#[0-9a-f]{6}$/i.test(data.color), "Use #RRGGBB for text color.");
  const page = doc.getPage(pageNumbers([data.page], doc.getPageCount())[0]! - 1), box = visiblePageBox(page);
  const font = await doc.embedFont(data.font as StandardFonts), width = data.width ?? box.x + box.width - data.x;
  fail(Number.isFinite(width) && width > 0 && width <= box.width, "Text width must fit the visible page.");
  const lines: string[] = [];
  try {
    for (const line of data.text.split(/\r?\n/)) {
      let current = "";
      for (const word of line.match(/\S+|\s+/g) ?? []) {
        const candidate = current + word;
        if (font.widthOfTextAtSize(candidate, data.size) > width && current) { lines.push(current); current = word; }
        else current = candidate;
        fail(font.widthOfTextAtSize(current, data.size) <= width, "A word exceeds the available text width. Increase width, reduce size or shorten it.");
      }
      lines.push(current);
    }
    fail(lines.length <= 200, "An inserted block supports at most 200 lines.");
    fail(Number.isFinite(data.x) && Number.isFinite(data.y) && data.x >= box.x && data.x + width <= box.x + box.width + .01 &&
      data.y + data.size <= box.y + box.height && data.y - (lines.length - 1) * data.size * 1.2 - data.size * .25 >= box.y,
    "The complete inserted text block must fit the visible page.");
    const resource = page.node.newFontDictionary("SWText", font.ref);
    const opacity = data.opacity ?? 1; fail(Number.isFinite(opacity) && opacity >= 0 && opacity <= 1, "Text opacity must be 0–1.");
    const graphics = page.node.newExtGState("SWTextAlpha", doc.context.register(doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity })));
    const color = [1, 3, 5].map(at => parseInt(data.color.slice(at, at + 2), 16) / 255);
    return doc.context.flateStream(`q\n${graphics} gs\n${color.join(" ")} rg\nBT\n${resource} ${data.size} Tf\n${data.size * 1.2} TL\n1 0 0 1 ${data.x} ${data.y} Tm\n` +
      lines.map((line, index) => `${index ? "T*\n" : ""}${font.encodeText(line)} Tj`).join("\n") + "\nET\nQ\n");
  } catch (error) {
    if (error instanceof Error && /WinAnsi|encode/.test(error.message)) throw new Error("The selected standard font cannot encode these characters. No text was inserted or replaced.");
    throw error;
  }
}
export async function applyInsertedTextOperation(doc: PDFDocument, op: InsertedTextOperation) {
  if (op.type === "insert_text") {
    const data: InsertedText = { id: crypto.randomUUID(), page: op.page, text: op.text, x: op.x, y: op.y, size: op.size ?? 12,
      color: op.color ?? "#142033", font: op.font ?? "Helvetica", ...(op.width === undefined ? {} : { width: op.width }), ...(op.opacity === undefined ? {} : { opacity: op.opacity }), ...(op.role === undefined ? {} : { role: op.role }) };
    const stream = doc.context.register(await content(doc, data)), page = doc.getPage(op.page - 1);
    page.node.addContentStream(stream);
    let entries = page.node.lookupMaybe(key, PDFArray); if (!entries) { entries = doc.context.obj([]); page.node.set(key, entries); }
    entries.push(doc.context.obj({ Stream: stream, SWTextFormat: PDFHexString.fromText(JSON.stringify(data)) }));
    return;
  }
  const found = records(doc).find(entry => entry.data.id === op.id);
  fail(found, "Inserted-text id is missing or its native content has changed. List current inserted text again.");
  if (op.type === "delete_inserted_text") {
    const contents = doc.getPage(found.data.page - 1).node.Contents();
    fail(contents instanceof PDFArray, "The inserted text's stream structure has changed; it cannot be removed independently.");
    for (let index = contents.size() - 1; index >= 0; index--) if (contents.get(index) === found.stream) contents.remove(index);
    found.entries.remove(found.index);
  } else {
    const { type: _, id: __, ...patch } = op;
    fail(Object.values(patch).some(value => value !== undefined), "Provide an actual inserted-text change.");
    const data = { ...found.data, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as InsertedText;
    doc.context.assign(found.stream, await content(doc, data));
    found.dict.set(formatKey, PDFHexString.fromText(JSON.stringify(data)));
  }
}
export type PdfDecorationOperation =
  | { type: "set_header_footer"; pages: number[]; header?: string; footer?: string; size?: number; margin?: number; color?: string }
  | { type: "set_watermark"; pages: number[]; text: string; size?: number; color?: string; opacity?: number };
export function isDecorationOperation(value: { type: string }): value is PdfDecorationOperation { return value.type === "set_header_footer" || value.type === "set_watermark"; }
export async function applyDecorationOperation(doc: PDFDocument, operation: PdfDecorationOperation) {
  const chosen = pageNumbers(operation.pages, doc.getPageCount());
  const roles: Array<InsertedText["role"]> = operation.type === "set_watermark" ? ["watermark"] : [operation.header === undefined ? undefined : "header", operation.footer === undefined ? undefined : "footer"].filter(Boolean) as Array<InsertedText["role"]>;
  fail(roles.length > 0, "Provide a header and/or footer. An empty string removes the matching workspace-created decoration.");
  // Only replace blocks made by this workspace. Never guess which source text is a header or watermark.
  for (const entry of records(doc).filter(entry => chosen.includes(entry.data.page) && roles.includes(entry.data.role))) await applyInsertedTextOperation(doc, { type: "delete_inserted_text", id: entry.data.id });
  for (const page of chosen) for (const role of roles) {
    const text = operation.type === "set_watermark" ? operation.text : role === "header" ? operation.header : operation.footer;
    fail(typeof text === "string" && text.length <= 1000, "Decoration text must contain at most 1000 characters.");
    if (!text) continue;
    const box = visiblePageBox(doc.getPage(page - 1)), size = operation.size ?? (role === "watermark" ? 36 : 10), margin = operation.type === "set_header_footer" ? operation.margin ?? 24 : 36;
    fail(Number.isFinite(margin) && margin >= 0 && margin < Math.min(box.width, box.height) / 2, "Decoration margin must fit inside the visible page.");
    const rendered = text.replaceAll("{page}", String(page)).replaceAll("{pages}", String(doc.getPageCount()));
    await applyInsertedTextOperation(doc, { type: "insert_text", page, role, text: rendered, size, color: operation.color ?? (role === "watermark" ? "#808080" : "#142033"),
      opacity: operation.type === "set_watermark" ? operation.opacity ?? .2 : 1, x: box.x + margin,
      y: role === "header" ? box.y + box.height - margin - size : role === "footer" ? box.y + margin + size * .25 : box.y + box.height / 2,
      width: box.width - margin * 2 });
  }
}
