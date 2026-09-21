import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PdfImagePixels } from "./image-source";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

/** Raw PDFium objects are ephemeral. Tool IDs are valid only at the edit revision that listed them. */
export type PdfNativeObject = { id: string; page: number; index: number; kind: "text" | "image" | "path" | "form" | "other";
  rect: number[]; matrix: number[]; text?: string; font?: string; fontSize?: number; opacity?: number; editable: boolean; reason?: string };
export type PdfNativeEdit =
  | { type: "replace_text"; id: string; expectedText: string; text: string }
  | { type: "delete_object"; id: string; expectedKind: "text" | "image" }
  | { type: "transform_object"; id: string; x?: number; y?: number; width?: number; height?: number; rotate?: 90 | 180 | 270; flip?: "horizontal" | "vertical" }
  | { type: "set_object_color"; id: string; color: string; opacity?: number };
export type PdfNativeImageEdit =
  | { type: "insert_image"; page: number; pixels: PdfImagePixels; x: number; y: number; width: number; height: number }
  | { type: "replace_image"; id: string; pixels: PdfImagePixels }
  | { type: "crop_image"; id: string; crop: { x: number; y: number; width: number; height: number } }
  | { type: "set_image_opacity"; id: string; opacity: number };
type Heap = { HEAPU8: Uint8Array; HEAPF32: Float32Array; HEAPU32: Uint32Array; _malloc(size: number): number; _free(pointer: number): void };
type Native = WrappedPdfiumModule & { pdfium: Heap };
export type PdfiumRequest = { bytes: Uint8Array; pages: number[]; operations?: Array<PdfNativeEdit | PdfNativeImageEdit>; boxes: Array<{ x: number; y: number; width: number; height: number }> };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const decoder = new TextDecoder("utf-16le");
export async function initializePdfium(wasmBinary: ArrayBuffer) {
  const module = await init({ wasmBinary, thisProgram: "office-pdf-worker" }) as unknown as Native;
  module.PDFiumExt_Init(); return module;
}
function allocate<T>(module: Native, size: number, body: (pointer: number) => T): T {
  check(size > 0 && size <= 64 * 1024 * 1024, "PDFium allocation exceeds the supported operation budget.");
  const pointer = module.pdfium._malloc(size); check(pointer, "PDFium memory allocation failed.");
  try { return body(pointer); } finally { module.pdfium._free(pointer); }
}
function objectText(module: Native, object: number, textPage: number) {
  const size = module.FPDFTextObj_GetText(object, textPage, 0, 0);
  check(size >= 0 && size <= 40_002, "A text object exceeds the supported 20,000-character limit.");
  return size ? allocate(module, size, ptr => { module.FPDFTextObj_GetText(object, textPage, ptr, size); return decoder.decode(module.pdfium.HEAPU8.slice(ptr, ptr + size)).replace(/\0+$/, ""); }) : "";
}
function numbers(module: Native, count: number, fill: (ptr: number) => unknown) {
  return allocate(module, count * 4, ptr => { check(fill(ptr), "PDFium could not inspect this object."); return Array.from(module.pdfium.HEAPF32.slice(ptr / 4, ptr / 4 + count)); });
}
function bounds(module: Native, object: number) { return numbers(module, 4, ptr => module.FPDFPageObj_GetBounds(object, ptr, ptr + 4, ptr + 8, ptr + 12)); }
function setMatrix(module: Native, object: number, matrix: number[]) {
  allocate(module, 24, ptr => { module.pdfium.HEAPF32.set(matrix, ptr / 4); check(module.FPDFPageObj_SetMatrix(object, ptr), "PDFium could not transform this object."); });
}
function setPixels(module: Native, object: number, pixels: PdfImagePixels) {
  const { width, height, rgba } = pixels;
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000 && rgba instanceof Uint8Array && rgba.length === width * height * 4, "Image dimensions exceed the supported pixel budget.");
  allocate(module, rgba.length, ptr => {
    const bgra = module.pdfium.HEAPU8;
    for (let at = 0; at < rgba.length; at += 4) { bgra[ptr + at] = rgba[at + 2]!; bgra[ptr + at + 1] = rgba[at + 1]!; bgra[ptr + at + 2] = rgba[at]!; bgra[ptr + at + 3] = rgba[at + 3]!; }
    const bitmap = module.FPDFBitmap_CreateEx(width, height, 4, ptr, width * 4); check(bitmap, "PDFium could not allocate the image bitmap.");
    try { check(module.FPDFImageObj_SetBitmap(0, 0, object, bitmap), "PDFium could not replace image pixels."); }
    finally { module.FPDFBitmap_Destroy(bitmap); }
  });
}
function renderedPixels(module: Native, doc: number, page: number, object: number): PdfImagePixels {
  const dimensions = allocate(module, 8, ptr => { check(module.FPDFImageObj_GetImagePixelSize(object, ptr, ptr + 4), "This image's source dimensions are unavailable."); return Array.from(module.pdfium.HEAPU32.slice(ptr / 4, ptr / 4 + 2)); });
  const [width, height] = dimensions as [number, number];
  check(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000, "This image exceeds the native pixel-edit budget.");
  const matrix = numbers(module, 6, ptr => module.FPDFPageObj_GetMatrix(object, ptr));
  // Render only this image at its original pixel dimensions, resolving its native soft mask.
  setMatrix(module, object, [width, 0, 0, height, 0, 0]);
  let bitmap = 0;
  try {
    bitmap = module.FPDFImageObj_GetRenderedBitmap(doc, page, object); check(bitmap, "This image cannot be decoded with its transparency preserved.");
    const w = module.FPDFBitmap_GetWidth(bitmap), h = module.FPDFBitmap_GetHeight(bitmap), format = module.FPDFBitmap_GetFormat(bitmap);
    check(w === width && h === height && [3, 4].includes(format), "The image renderer returned an unsupported pixel format or geometry.");
    const stride = module.FPDFBitmap_GetStride(bitmap), ptr = module.FPDFBitmap_GetBuffer(bitmap), rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const source = ptr + y * stride + x * 4, target = (y * w + x) * 4;
      const alpha = format === 4 ? module.pdfium.HEAPU8[source + 3]! : 255;
      rgba[target] = module.pdfium.HEAPU8[source + 2]!; rgba[target + 1] = module.pdfium.HEAPU8[source + 1]!; rgba[target + 2] = module.pdfium.HEAPU8[source]!; rgba[target + 3] = alpha;
    }
    return { width: w, height: h, rgba };
  } finally { if (bitmap) module.FPDFBitmap_Destroy(bitmap); setMatrix(module, object, matrix); }
}
function fontName(module: Native, font: number) {
  const size = module.FPDFFont_GetBaseFontName(font, 0, 0); if (!size || size > 1024) return "Unknown";
  return allocate(module, size, ptr => { module.FPDFFont_GetBaseFontName(font, ptr, size); return new TextDecoder().decode(module.pdfium.HEAPU8.slice(ptr, ptr + size)).replace(/\0+$/, ""); });
}
function setText(module: Native, object: number, text: string) {
  allocate(module, (text.length + 1) * 2, ptr => {
    const view = new DataView(module.pdfium.HEAPU8.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(ptr + i * 2, text.charCodeAt(i), true);
    view.setUint16(ptr + text.length * 2, 0, true);
    check(module.FPDFText_SetText(object, ptr), "The source PDF font cannot encode this replacement. No changes were committed.");
  });
}
function save(module: Native, doc: number) {
  const writer = module.PDFiumExt_OpenFileWriter(); check(writer, "PDFium could not create a file writer.");
  try {
    check(module.PDFiumExt_SaveAsCopy(doc, writer), "PDFium could not serialize the edited PDF.");
    const length = module.PDFiumExt_GetFileWriterSize(writer); check(length <= 30 * 1024 * 1024, "The edited PDF exceeds 30 MB.");
    return allocate(module, length, ptr => { module.PDFiumExt_GetFileWriterData(writer, ptr, length); return module.pdfium.HEAPU8.slice(ptr, ptr + length); });
  } finally { module.PDFiumExt_CloseFileWriter(writer); }
}
/** Runs in a dedicated, terminable worker. Never mutates the caller's original bytes. */
type PdfiumResult = { objects: PdfNativeObject[]; bytes?: Uint8Array; pendingImageOpacity?: Array<{ tag: string; page: number; opacity: number }> };
/** Internal synchronous native pass; image opacity must be finalized by executePdfiumTransaction. */
export function executePdfium(module: Native, request: PdfiumRequest): PdfiumResult {
  check(request.bytes.byteLength <= 30 * 1024 * 1024 && request.pages.length > 0 && request.pages.length <= 5, "Inspect at most five PDF pages per native request.");
  check(!request.operations || request.operations.length > 0 && request.operations.length <= 50, "Apply 1–50 native object operations per batch.");
  return allocate(module, request.bytes.byteLength, ptr => {
    module.pdfium.HEAPU8.set(request.bytes, ptr);
    const doc = module.FPDF_LoadMemDocument(ptr, request.bytes.byteLength, ""); check(doc, "PDFium could not open the PDF.");
    const handles: number[] = [], textHandles: number[] = [], pageHandles = new Map<number, number>();
    try {
      const objects: PdfNativeObject[] = [], native = new Map<string, { object: number; page: number; textPage: number; item: PdfNativeObject; font: number }>();
      const count = module.FPDF_GetPageCount(doc); check(count > 0 && count <= 500, "PDFium page count is unsupported.");
      let textBudget = 0;
      for (const number of new Set(request.pages)) {
        check(Number.isInteger(number) && number >= 1 && number <= count, "Invalid native PDF page number.");
        const page = module.FPDF_LoadPage(doc, number - 1); check(page, "PDFium could not load this page."); handles.push(page);
        pageHandles.set(number, page);
        const textPage = module.FPDFText_LoadPage(page); check(textPage, "PDFium could not load the text layer."); textHandles.push(textPage);
        const length = module.FPDFPage_CountObjects(page); check(length <= 5000, "This page exceeds 5000 native objects. Use a specialist editor for this page.");
        for (let index = 0; index < length; index++) {
          const object = module.FPDFPage_GetObject(page, index), type = module.FPDFPageObj_GetType(object);
          const kind = type === 1 ? "text" : type === 3 ? "image" : type === 2 ? "path" : type === 5 ? "form" : "other";
          const rect = bounds(module, object), matrix = numbers(module, 6, ptr => module.FPDFPageObj_GetMatrix(object, ptr));
          const item: PdfNativeObject = { id: `p${number}:o${index}`, page: number, index, kind, rect, matrix,
            editable: kind === "text" || kind === "image", ...(["text", "image"].includes(kind) ? {} : { reason: "Only top-level text and image objects can be edited; nested/shared forms and paths are preserved." }) };
          allocate(module, 16, ptr => { if (module.FPDFPageObj_GetFillColor(object, ptr, ptr + 4, ptr + 8, ptr + 12)) item.opacity = module.pdfium.HEAPU32[ptr / 4 + 3]! / 255; });
          let font = 0;
          if (kind === "text") { item.text = objectText(module, object, textPage); font = module.FPDFTextObj_GetFont(object); item.font = fontName(module, font); item.fontSize = numbers(module, 1, ptr => module.FPDFTextObj_GetFontSize(object, ptr))[0]; }
          textBudget += item.text?.length ?? 0; check(textBudget <= 2_000_000, "Native text inventory exceeds two million characters. Inspect fewer pages.");
          objects.push(item); native.set(item.id, { object, page, textPage, item, font });
        }
      }
      if (!request.operations) return { objects };
      const changed = new Set<number>(), deleted = new Set<string>();
      const replacements = new Map<string, { page: number; expected: string }>();
      const imageOpacity = new Map<string, { tag: string; page: number; opacity: number }>();
      for (const operation of request.operations) {
        if (operation.type === "insert_image") {
          const page = pageHandles.get(operation.page), box = request.boxes[operation.page - 1];
          check(page && box && [operation.x, operation.y, operation.width, operation.height].every(Number.isFinite) && operation.width > 0 && operation.height > 0 && operation.x >= box.x && operation.y >= box.y && operation.x + operation.width <= box.x + box.width && operation.y + operation.height <= box.y + box.height, "Inserted image must fit the visible page, which must be included in pages.");
          const image = module.FPDFPageObj_NewImageObj(doc); check(image, "PDFium could not create a native image object.");
          try { setPixels(module, image, operation.pixels); setMatrix(module, image, [operation.width, 0, 0, operation.height, operation.x, operation.y]); }
          catch (error) { module.FPDFPageObj_Destroy(image); throw error; }
          module.FPDFPage_InsertObject(page, image); changed.add(page); continue;
        }
        const target = native.get(operation.id); check(target && !deleted.has(operation.id) && target.item.editable, "The requested object is missing, deleted or unsupported. List current page objects before editing.");
        const { object, item, page } = target;
        if (operation.type === "delete_object" || operation.type === "replace_text" && operation.text === "") {
          check(operation.type === "replace_text" ? item.kind === "text" && operation.expectedText === item.text : operation.expectedKind === item.kind,
            "Object kind or exact source text changed. No object was deleted.");
          check(module.FPDFPage_RemoveObject(page, object), "PDFium could not remove the selected native object."); module.FPDFPageObj_Destroy(object); deleted.add(item.id); replacements.delete(item.id); imageOpacity.delete(item.id);
        } else if (operation.type === "replace_text") {
          check(item.kind === "text" && item.text === operation.expectedText && typeof operation.text === "string" && operation.text.length <= 10_000 && !/[\r\n\0]/.test(operation.text), "Use the exact current text object and a replacement of at most 10,000 characters on one line.");
          const available = new Set([...native.values()].filter(entry => entry.font === target.font).flatMap(entry => [...(entry.item.text ?? "")]));
          const standard = !module.FPDFFont_GetIsEmbedded(target.font) && /^(Helvetica|Times|Courier|Arial)/.test(item.font ?? "");
          check([...operation.text].every(char => available.has(char) || standard && /^[\x20-\x7e\xa0-\xff]$/.test(char)), "The embedded font has no verified glyph coverage for part of this replacement. Use characters already present in this font or a separately inserted text block.");
          setText(module, object, operation.text); replacements.set(item.id, { page: item.page, expected: operation.text }); item.text = operation.text;
        } else if (operation.type === "transform_object") {
          const [left, bottom, right, top] = bounds(module, object) as [number, number, number, number];
          const width = operation.width ?? right - left, height = operation.height ?? top - bottom;
          const x = operation.x ?? left, y = operation.y ?? bottom;
          check([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0, "Object position and dimensions must be finite and positive.");
          const sx = width / (right - left), sy = height / (top - bottom); check(Number.isFinite(sx) && Number.isFinite(sy), "Zero-size objects cannot be transformed.");
          module.FPDFPageObj_Transform(object, sx, 0, 0, sy, x - sx * left, y - sy * bottom);
          if (operation.rotate !== undefined || operation.flip !== undefined) {
            check(operation.rotate === undefined || [90, 180, 270].includes(operation.rotate), "Rotation must be 90, 180 or 270 degrees.");
            check(operation.flip === undefined || ["horizontal", "vertical"].includes(operation.flip), "Flip must be horizontal or vertical.");
            const angle = (operation.rotate ?? 0) * Math.PI / 180, cx = x + width / 2, cy = y + height / 2;
            const fx = operation.flip === "horizontal" ? -1 : 1, fy = operation.flip === "vertical" ? -1 : 1;
            const a = Math.cos(angle) * fx, b = Math.sin(angle) * fx, c = -Math.sin(angle) * fy, d = Math.cos(angle) * fy;
            module.FPDFPageObj_Transform(object, a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy);
          }
        } else if (operation.type === "replace_image" || operation.type === "crop_image" || operation.type === "set_image_opacity") {
          check(item.kind === "image", "Pixel operations require a current native image object.");
          if (operation.type === "replace_image") setPixels(module, object, operation.pixels);
          else if (operation.type === "set_image_opacity") {
            check(Number.isFinite(operation.opacity) && operation.opacity >= 0 && operation.opacity <= 1, "Image opacity must be 0–1.");
            let pending = imageOpacity.get(item.id);
            if (!pending) {
              const tag = "SWImageOpacity" + crypto.randomUUID().replaceAll("-", "");
              check(module.FPDFPageObj_AddMark(object, tag), "This image cannot be marked for independent opacity.");
              pending = { tag, page: item.page, opacity: operation.opacity }; imageOpacity.set(item.id, pending);
            }
            pending.opacity = operation.opacity;
          } else {
            let pixels = renderedPixels(module, doc, page, object);
            {
              const crop = operation.crop;
              check(crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1, "Image crop uses fractions 0–1 from the source image's top-left.");
              const x = Math.round(crop.x * pixels.width), y = Math.round(crop.y * pixels.height), width = Math.round(crop.width * pixels.width), height = Math.round(crop.height * pixels.height);
              check(width > 0 && height > 0 && x + width <= pixels.width && y + height <= pixels.height, "The requested image crop is smaller than a pixel or exceeds the image.");
              const rgba = new Uint8Array(width * height * 4);
              for (let row = 0; row < height; row++) rgba.set(pixels.rgba.subarray(((y + row) * pixels.width + x) * 4, ((y + row) * pixels.width + x + width) * 4), row * width * 4);
              const [a, b, c, d, e, f] = numbers(module, 6, ptr => module.FPDFPageObj_GetMatrix(object, ptr)) as [number, number, number, number, number, number];
              const left = x / pixels.width, bottom = 1 - (y + height) / pixels.height, sx = width / pixels.width, sy = height / pixels.height;
              setMatrix(module, object, [a * sx, b * sx, c * sy, d * sy, e + a * left + c * bottom, f + b * left + d * bottom]);
              pixels = { width, height, rgba };
            }
            setPixels(module, object, pixels);
          }
        } else if (operation.type === "set_object_color") {
          check(item.kind === "text" && /^#[0-9a-f]{6}$/i.test(operation.color), "Set text fill color using #RRGGBB. Image pixels require an image replacement operation.");
          const alpha = operation.opacity ?? 1; check(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1, "Opacity must be0–1.");
          const [r, g, b] = [1, 3, 5].map(at => parseInt(operation.color.slice(at, at + 2), 16));
          check(module.FPDFPageObj_SetFillColor(object, r!, g!, b!, Math.round(alpha * 255)), "This text object does not support changing its fill color.");
        } else throw new Error("Unknown native PDF object operation.");
        if (!deleted.has(item.id)) {
          const [left, bottom, right, top] = bounds(module, object), box = request.boxes[item.page - 1];
          check(box && left! >= box.x - 1 && bottom! >= box.y - 1 && right! <= box.x + box.width + 1 && top! <= box.y + box.height + 1,
            "The edited object would fall outside the visible page. No changes were committed.");
        }
        changed.add(page);
      }
      for (const page of changed) check(module.FPDFPage_GenerateContent(page), "PDFium could not generate the edited page's actual content stream.");
      const bytes = save(module, doc);
      // Validate semantic replacement after serialization by reopening with the same native engine.
      if (replacements.size) allocate(module, bytes.length, pointer => {
        module.pdfium.HEAPU8.set(bytes, pointer); const verified = module.FPDF_LoadMemDocument(pointer, bytes.length, ""); check(verified, "Edited PDF could not be reopened.");
        try { for (const replacement of replacements.values()) {
          const p = module.FPDF_LoadPage(verified, replacement.page - 1), tp = module.FPDFText_LoadPage(p);
          try { const texts = Array.from({ length: module.FPDFPage_CountObjects(p) }, (_, i) => module.FPDFPage_GetObject(p, i)).filter(o => module.FPDFPageObj_GetType(o) === 1).map(o => objectText(module, o, tp));
            check(texts.includes(replacement.expected), "Serialized replacement text did not round-trip. No changes were committed.");
          } finally { module.FPDFText_ClosePage(tp); module.FPDF_ClosePage(p); }
        } } finally { module.FPDF_CloseDocument(verified); }
      });
      return { objects: [], bytes, ...(imageOpacity.size ? { pendingImageOpacity: [...imageOpacity.values()] } : {}) };
    } finally { for (const text of textHandles) module.FPDFText_ClosePage(text); for (const page of handles) module.FPDF_ClosePage(page); module.FPDF_CloseDocument(doc); }
  });
}
/** PDFium's generic fill setter does not serialize image alpha. Apply an explicit
 * native ExtGState to only the uniquely marked image draw, preserving its pixels.
 * The mark is generated by this transaction, not guessed from source text. */
export async function executePdfiumTransaction(module: Native, request: PdfiumRequest): Promise<{ objects: PdfNativeObject[]; bytes?: Uint8Array }> {
  const result = executePdfium(module, request);
  if (!result.bytes || !result.pendingImageOpacity?.length) return result;
  const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
  for (const pending of result.pendingImageOpacity) {
    const page = doc.getPage(pending.page - 1), contents = page.node.Contents();
    const entries = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))];
    const graphics = page.node.newExtGState("SWImageAlpha", doc.context.register(doc.context.obj({ Type: "ExtGState", ca: pending.opacity, CA: pending.opacity })));
    let matches = 0;
    for (const entry of entries) {
      const stream = doc.context.lookup(entry); check(stream instanceof PDFRawStream && entry instanceof PDFRef, "This generated image content stream cannot safely receive opacity.");
      const decoded = decodePDFRawStream(stream).decode(); check(decoded.length <= 16 * 1024 * 1024, "Generated image page content exceeds the opacity budget.");
      let content = ""; for (let at = 0; at < decoded.length; at += 8192) content += String.fromCharCode(...decoded.subarray(at, at + 8192));
      const pattern = new RegExp("/" + pending.tag + "\\s+BMC\\b([\\s\\S]*?)\\bEMC\\b", "g");
      const updated = content.replace(pattern, (match, body: string) => {
        matches++; check(/\/[^\s]+\s+Do\b/.test(body) && !/\b(BT|ET|Tj|TJ|BI|BMC|BDC)\b/.test(body), "The marked object is not an isolated native image draw.");
        const draws = [...body.matchAll(/\/[^\s]+\s+Do\b/g)]; check(draws.length === 1, "The opacity mark does not identify exactly one image draw.");
        // The native writer can emit its own gs reset within the mark. Override
        // alpha immediately before Do, inside q/Q, after those existing settings.
        return match.replace(body, body.replace(draws[0]![0], `q\n${graphics} gs\n${draws[0]![0]}\nQ`));
      });
      if (updated !== content) doc.context.assign(entry, doc.context.flateStream(Uint8Array.from(updated, char => char.charCodeAt(0))));
    }
    check(matches === 1, "The image opacity target did not serialize uniquely. No changes were committed.");
  }
  const bytes = await doc.save({ updateFieldAppearances: false }); check(bytes.length <= 30 * 1024 * 1024, "The edited PDF exceeds 30 MB.");
  return { objects: [], bytes };
}
