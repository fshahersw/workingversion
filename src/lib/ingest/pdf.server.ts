// Bounded production PDF reader. Uses the PDF page tree and font mappings;
// raw object order and literal string scans are never used for source citations.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
export type PdfText = { pageCount: number; pages: string[] };

export async function extractPdf(bytes: Uint8Array): Promise<PdfText> {
  if (bytes.byteLength > 30 * 1024 * 1024) throw new Error("PDF exceeds the 30 MB extraction limit.");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data: bytes.slice(), verbosity: 0,
    useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
    cMapUrl: join(assets, "cmaps").replaceAll("\\", "/") + "/", cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts").replaceAll("\\", "/") + "/",
    wasmUrl: join(assets, "wasm").replaceAll("\\", "/") + "/",
  });
  const deadline = setTimeout(() => { void task.destroy(); }, 30_000);
  try {
    const doc = await task.promise;
    if (doc.numPages > 500) throw new Error("PDF exceeds the 500-page extraction limit. Split it into volumes.");
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        chars += text.length;
        if (chars > 5_000_000) throw new Error("PDF exceeds the extracted-text limit; no partial extraction was accepted.");
        pages.push(text);
      } finally { page.cleanup(); }
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    clearTimeout(deadline);
    await task.destroy();
  }
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length > 5 && latin1(bytes.slice(0, 5)) === "%PDF-";

/** Same page-aware chunking the production runner uses (~3600 chars). */
export function chunkPages(pages: string[], target = 3600): {
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
  token_count: number;
}[] {
  const out: { chunk_index: number; page_start: number; page_end: number; content: string; token_count: number }[] = [];
  let buf = "";
  let start = 1;
  const flush = (end: number) => {
    const content = buf.trim();
    if (content) {
      out.push({
        chunk_index: out.length,
        page_start: start,
        page_end: end,
        content,
        token_count: Math.ceil(content.length / 4),
      });
    }
    buf = "";
  };
  pages.forEach((text, i) => {
    const pageNo = i + 1;
    if (!buf) start = pageNo;
    buf += (buf ? "\n\n" : "") + text;
    if (buf.length >= target) flush(pageNo);
  });
  flush(pages.length);
  return out;
}
