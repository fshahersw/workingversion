import { isLowQualityText } from "@/lib/pile/text-quality";
import { mapPool } from "@/lib/pile/async";
import {
  DOC_CHARS_PER_PAGE,
  MAX_BYTES,
  MAX_PAGES,
  MAX_PAGES_PER_FILE,
  PDF_PAGE_CONCURRENCY,
} from "@/lib/pile/limits";
import { reconstructReporterLines } from "@/lib/pile/pdf-lines";
import { ensurePromiseWithResolvers } from "@/lib/pdf-compat";

/** No single file may swallow the whole session budget. */
const FILE_PAGE_CAP = Math.min(MAX_PAGES, MAX_PAGES_PER_FILE);

export type PageText = { page: number; text: string };

export type ExtractedFile = {
  name: string;
  kind: "pdf" | "docx" | "txt" | "xlsx" | "pptx";
  pages: PageText[];
  pageCount: number;
  charCount: number;
  /** Pages with no selectable text or a garbage PACER text layer. */
  emptyPages: number;
};

export { MAX_PAGES, MAX_BYTES };

export function fileKind(file: File): ExtractedFile["kind"] | null {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".xlsx") || n.endsWith(".xlsm")) return "xlsx";
  if (n.endsWith(".pptx") || n.endsWith(".pptm")) return "pptx";
  if (n.endsWith(".ppt")) return null;
  if (n.endsWith(".txt") || n.endsWith(".md") || file.type.startsWith("text/")) return "txt";
  return null;
}

type Progress = (done: number, total: number) => void;

/** Extract page-anchored text from one PDF / Office / text file. */
export async function extractFile(
  file: File,
  onProgress?: Progress,
  signal?: AbortSignal,
  opts?: {
    maxPages?: number;
    maxBytes?: number;
    layout?: "flow" | "transcript";
    requireComplete?: boolean;
  },
): Promise<ExtractedFile> {
  const kind = fileKind(file);
  const pageCap = Math.min(FILE_PAGE_CAP, opts?.maxPages ?? FILE_PAGE_CAP);
  const byteCap = opts?.maxBytes ?? MAX_BYTES;
  if (!kind) {
    const n = file.name.toLowerCase();
    if (n.endsWith(".ppt") || n.endsWith(".xls")) {
      throw new Error(
        `${file.name}: use .pptx / .xlsx (legacy binary Office files are not supported)`,
      );
    }
    throw new Error(`${file.name}: unsupported type (PDF, Word, Excel, PowerPoint or TXT)`);
  }
  if (file.size > byteCap)
    throw new Error(`${file.name}: over the ${Math.round(byteCap / 1024 / 1024)} MB limit`);

  if (kind === "txt") {
    const text = await file.text();
    return paginateText(file.name, "txt", text, pageCap, opts?.requireComplete);
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const buf = await file.arrayBuffer();
    // Headings make real section boundaries; a blind character count does not.
    try {
      const html = await mammoth.convertToHtml({ arrayBuffer: buf });
      const sections = htmlToSections(html.value ?? "");
      if (sections.length)
        return paginateSections(file.name, "docx", sections, pageCap, opts?.requireComplete);
    } catch {
      /* fall through to raw text */
    }
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    return paginateText(file.name, "docx", res.value ?? "", pageCap, opts?.requireComplete);
  }
  if (kind === "xlsx") {
    const { extractXlsx } = await import("./office-text");
    const res = await extractXlsx(file, pageCap);
    onProgress?.(res.pages.length, res.pages.length);
    return {
      name: file.name,
      kind: "xlsx",
      pages: res.pages,
      pageCount: res.pages.length,
      charCount: res.charCount,
      emptyPages: res.pages.filter((p) => !p.text.trim()).length,
    };
  }
  if (kind === "pptx") {
    const { extractPptx } = await import("./office-text");
    const res = await extractPptx(file, pageCap);
    onProgress?.(res.pages.length, res.pages.length);
    return {
      name: file.name,
      kind: "pptx",
      pages: res.pages,
      pageCount: res.pages.length,
      charCount: res.charCount,
      emptyPages: res.pages.filter((p) => !p.text.trim()).length,
    };
  }

  ensurePromiseWithResolvers();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { configurePdfjsWorker } = await import("./pdf-worker");
  await configurePdfjsWorker(pdfjs);

  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const compatibilityFailure = /undefined is not a function|withResolvers/i.test(msg);
    throw new Error(
      compatibilityFailure
        ? `${file.name}: this browser could not start the PDF reader. Update Safari or try again in Chrome.`
        : /workerSrc|worker/i.test(msg)
          ? `${file.name}: PDF worker failed (${msg}). Reload the page and try again.`
          : `${file.name}: ${msg}`,
    );
  }
  if (opts?.requireComplete && doc.numPages > pageCap) {
    const count = doc.numPages;
    await doc.destroy();
    throw new Error(
      `${file.name}: ${count} pages exceeds the ${pageCap}-page per-file limit. Split the transcript before analysis so no testimony is omitted.`,
    );
  }
  const total = Math.min(doc.numPages, pageCap);
  const pages: PageText[] = new Array(total);
  let done = 0;

  await mapPool(
    Array.from({ length: total }, (_, i) => i + 1),
    PDF_PAGE_CONCURRENCY,
    async (n) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text =
        opts?.layout === "transcript"
          ? pdfItemsToTranscriptText(content.items)
          : pdfItemsToText(content.items);
      page.cleanup();
      pages[n - 1] = { page: n, text };
      done += 1;
      onProgress?.(done, total);
    },
    signal,
  );
  await doc.destroy();

  const list = pages.filter(Boolean);
  const empty = list.filter((p) => !p.text || isLowQualityText(p.text)).length;
  if (doc.numPages > pageCap) {
    list.push({
      page: pageCap,
      text: `[Truncated at ${pageCap} pages; this file has ${doc.numPages}.]`,
    });
  }

  return {
    name: file.name,
    kind: "pdf",
    pages: list,
    pageCount: list.length,
    charCount: list.reduce((n, p) => n + p.text.length, 0),
    emptyPages: empty,
  };
}

type PdfTextItem = {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  hasEOL?: boolean;
};

function pdfItemsToText(items: unknown[]): string {
  let out = "";
  let lastY = 0;
  let lastEnd = 0;
  let lastH = 12;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as PdfTextItem;
    const str = it.str ?? "";
    if (!str && !it.hasEOL) continue;
    const tr = it.transform;
    const x = tr ? Number(tr[4]) : 0;
    const y = tr ? Number(tr[5]) : 0;
    const w = Number(it.width ?? 0);
    const h = Number(it.height ?? lastH) || lastH;
    if (out) {
      const dy = Math.abs(y - lastY);
      const gap = x - lastEnd;
      if (dy > h * 0.7) out += "\n";
      else if (gap > Math.max(h * 0.22, 1.2)) out += " ";
    }
    out += str;
    lastY = y;
    lastEnd = x + w;
    lastH = h;
    if (it.hasEOL) out += "\n";
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function pdfItemsToTranscriptText(items: unknown[]): string {
  const glyphs = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as PdfTextItem;
    const str = it.str ?? "";
    if (!str && !it.hasEOL) continue;
    const tr = it.transform;
    glyphs.push({
      x: tr ? Number(tr[4]) : 0,
      y: tr ? Number(tr[5]) : 0,
      w: Number(it.width ?? 0),
      h: Number(it.height ?? 12) || 12,
      str,
    });
  }
  const lined = reconstructReporterLines(glyphs);
  return lined || pdfItemsToText(items);
}

/** Split converted Word HTML on headings so a "page" is a real section. */
function htmlToSections(html: string): { heading: string; text: string }[] {
  if (!html.trim()) return [];
  const parts = html.split(/(?=<h[1-4][\s>])/i);
  const out: { heading: string; text: string }[] = [];
  for (const part of parts) {
    const heading = stripTags(part.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1] ?? "");
    const body = stripTags(part.replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/i, ""));
    if (!heading && !body) continue;
    out.push({ heading, text: body });
  }
  return out.length > 1 ? out : [];
}

function stripTags(html: string): string {
  return html
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Sections become pages; an oversized section is split further, keeping its heading. */
function paginateSections(
  name: string,
  kind: "docx",
  sections: { heading: string; text: string }[],
  maxPages = FILE_PAGE_CAP,
  requireComplete = false,
): ExtractedFile {
  const pages: PageText[] = [];
  for (const section of sections) {
    if (pages.length >= maxPages) {
      if (requireComplete)
        throw new Error(
          `${name}: text exceeds ${maxPages} extracted pages. Split the document before analysis.`,
        );
      break;
    }
    const head = section.heading ? `${section.heading}\n\n` : "";
    const body = section.text;
    if (head.length + body.length <= DOC_CHARS_PER_PAGE) {
      pages.push({ page: pages.length + 1, text: `${head}${body}`.trim() });
      continue;
    }
    const paras = body.split(/\n{2,}/);
    let buf: string[] = [];
    let size = 0;
    const flush = () => {
      if (!buf.length) return;
      if (pages.length >= maxPages) {
        if (requireComplete)
          throw new Error(
            `${name}: text exceeds ${maxPages} extracted pages. Split the document before analysis.`,
          );
        return;
      }
      pages.push({ page: pages.length + 1, text: `${head}${buf.join("\n\n")}`.trim() });
      buf = [];
      size = 0;
    };
    for (const p of paras) {
      if (size && size + p.length > DOC_CHARS_PER_PAGE) flush();
      buf.push(p);
      size += p.length + 2;
    }
    flush();
  }
  return {
    name,
    kind,
    pages,
    pageCount: pages.length,
    charCount: pages.reduce((n, p) => n + p.text.length, 0),
    emptyPages: pages.filter((p) => !p.text.trim()).length,
  };
}

function paginateText(
  name: string,
  kind: "docx" | "txt",
  raw: string,
  maxPages = FILE_PAGE_CAP,
  requireComplete = false,
): ExtractedFile {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const paras = text.split(/\n{2,}/);
  const pages: PageText[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of paras) {
    if (size && size + p.length > DOC_CHARS_PER_PAGE) {
      pages.push({ page: pages.length + 1, text: buf.join("\n\n") });
      buf = [];
      size = 0;
    }
    buf.push(p);
    size += p.length + 2;
    if (pages.length >= maxPages) {
      if (requireComplete)
        throw new Error(
          `${name}: text exceeds ${maxPages} extracted pages. Split the document before analysis.`,
        );
      break;
    }
  }
  if (buf.length && pages.length < maxPages)
    pages.push({ page: pages.length + 1, text: buf.join("\n\n") });
  return {
    name,
    kind,
    pages,
    pageCount: pages.length,
    charCount: text.length,
    emptyPages: pages.filter((p) => !p.text.trim()).length,
  };
}

export function mergeExtracted(files: ExtractedFile[]): {
  pages: PageText[];
  offsets: { name: string; from: number; to: number }[];
} {
  const pages: PageText[] = [];
  const offsets: { name: string; from: number; to: number }[] = [];
  for (const f of files) {
    const from = pages.length + 1;
    for (const p of f.pages) pages.push({ page: pages.length + 1, text: p.text });
    offsets.push({ name: f.name, from, to: pages.length });
  }
  return { pages, offsets };
}

export function transcriptFileKind(file: File): "pdf" | "docx" | "txt" | null {
  const kind = fileKind(file);
  return kind === "pdf" || kind === "docx" || kind === "txt" ? kind : null;
}
