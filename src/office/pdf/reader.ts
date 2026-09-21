import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { configurePdfjsWorker } from "@/lib/pdf-worker";
import { PDF_MAX_PAGES } from "./document";

export type PdfPageText = { page: number; text: string; items: TextItem[]; box?: number[]; rotation?: number };
export async function openPdfView(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  await configurePdfjsWorker(pdfjs);
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  if (doc.numPages > PDF_MAX_PAGES) { await task.destroy(); throw new Error("PDF exceeds the 500-page review limit."); }
  return doc;
}
export async function pageText(doc: PDFDocumentProxy, n: number): Promise<PdfPageText> {
  if (!Number.isInteger(n) || n < 1 || n > doc.numPages) throw new Error("Choose a page in this document.");
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const items = content.items.filter((item): item is TextItem => "str" in item);
  return { page: n, items, box: page.view, rotation: page.rotate, text: items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("") };
}
/** Separate canvas keeps a model capture independent of the user's active viewport. */
export async function capturePdfPage(doc: PDFDocumentProxy, n: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isInteger(n) || n < 1 || n > doc.numPages) throw new Error("Choose a page in this document.");
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(base.width, base.height)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const render = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
  const abort = () => render.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await render.promise; signal?.throwIfAborted();
    return { mime: "image/png", base64: canvas.toDataURL("image/png").split(",")[1]! };
  } finally { signal?.removeEventListener("abort", abort); canvas.width = canvas.height = 0; }
}

/** Only axis-aligned text can be highlighted safely in this initial editor. */
export function highlightRects(page: PdfPageText, quote: string): number[][] {
  if (!quote.trim()) throw new Error("Choose an exact quote to highlight.");
  const start = page.text.indexOf(quote);
  if (start < 0) throw new Error("The exact quote is not present on this page. Read the page again.");
  if (page.text.indexOf(quote, start + quote.length) >= 0) throw new Error("The quote is ambiguous. Include more surrounding text.");
  const rects: number[][] = [];
  let at = 0;
  for (const item of page.items) {
    const end = at + item.str.length;
    if (end > start && at < start + quote.length && item.str.trim()) {
      const [a, b, c, d, x, y] = item.transform as number[];
      if (Math.abs(b ?? 0) > 0.01 || Math.abs(c ?? 0) > 0.01 || (a ?? 0) <= 0 || (d ?? 0) <= 0)
        throw new Error("Highlighting rotated or vertical text is not supported. Add a page note instead.");
      // Cover the complete intersecting text run, never pretend per-character glyph bounds.
      rects.push([x!, y! - item.height * 0.2, item.width, item.height]);
    }
    at = end + 1;
  }
  if (!rects.length) throw new Error("The quote has no supported text geometry.");
  return rects;
}
