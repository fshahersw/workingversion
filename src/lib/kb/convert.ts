// Convert parsed source data into the CanonicalDoc shape. Pure + deterministic:
// byte-level parsing (BDA async OCR, SheetJS, pdf text) happens in the ingest
// worker; these functions just map already-parsed data to canonical blocks so
// they are unit-testable and reused across converters.

import type { Block, CanonicalDoc, Page, TableData } from "./canonical.ts";

export type DocMeta = {
  fileName: string;
  mime?: string;
  sha256?: string;
  docId?: string;
};

// --- markdown → blocks -------------------------------------------------------

function parseTable(lines: string[], start: number): { table: TableData; next: number } | null {
  const isRow = (l: string) => l.trim().startsWith("|");
  const isSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
  if (!isRow(lines[start] ?? "") || !isSep(lines[start + 1] ?? "")) return null;
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[start]!);
  const rows: string[][] = [];
  let i = start + 2;
  for (; i < lines.length && isRow(lines[i]!); i++) rows.push(cells(lines[i]!));
  return { table: { header, rows }, next: i };
}

/** Parse markdown into canonical blocks (headings, GFM tables, lists, paras). */
export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ").trim() });
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: "list", text: list.join("\n").trim() });
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", text: heading[2]!.trim(), level: heading[1]!.length });
      continue;
    }
    if (trimmed.startsWith("|")) {
      const parsed = parseTable(lines, i);
      if (parsed) {
        flushPara();
        flushList();
        const { header, rows } = parsed.table;
        const text = [header, ...rows].map((r) => r.join(" | ")).join("\n");
        blocks.push({ kind: "table", text, table: parsed.table });
        i = parsed.next - 1;
        continue;
      }
    }
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(trimmed)) {
      flushPara();
      list.push(trimmed.replace(/^([-*+]|\d+[.)])\s+/, ""));
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return blocks;
}

// --- BDA result → canonical --------------------------------------------------

export type BdaLike = { markdown: string; pageCount?: number };

/** Map a BDA readResult() (consolidated markdown, optional "[page N]" markers)
 *  into a page-anchored CanonicalDoc. */
export function bdaToCanonical(res: BdaLike, meta: DocMeta): CanonicalDoc {
  const md = res.markdown ?? "";
  const marker = /\n*\[page (\d+)\]\n/g;
  const pages: Page[] = [];
  if (marker.test(md)) {
    marker.lastIndex = 0;
    const parts: { pageNo: number; body: string }[] = [];
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    let lastPage = 0;
    while ((m = marker.exec(md))) {
      if (lastPage) parts.push({ pageNo: lastPage, body: md.slice(lastEnd, m.index) });
      lastPage = Number(m[1]);
      lastEnd = marker.lastIndex;
    }
    if (lastPage) parts.push({ pageNo: lastPage, body: md.slice(lastEnd) });
    for (const p of parts) {
      const blocks = markdownToBlocks(p.body);
      if (blocks.length) pages.push({ pageNo: p.pageNo, blocks, source: "bda" });
    }
  }
  if (!pages.length) {
    pages.push({ pageNo: 1, blocks: markdownToBlocks(md), source: "bda" });
  }
  return {
    ...(meta.docId ? { docId: meta.docId } : {}),
    ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    fileName: meta.fileName,
    ...(meta.mime ? { mime: meta.mime } : {}),
    pageCount: res.pageCount && res.pageCount > 0 ? res.pageCount : pages.length,
    pages,
  };
}

// --- spreadsheet → canonical -------------------------------------------------

export type SheetInput = { name: string; rows: string[][] };

/** One page per sheet: a heading (sheet name) + a table block (row 0 = header). */
export function sheetsToCanonical(sheets: SheetInput[], meta: DocMeta): CanonicalDoc {
  const pages: Page[] = [];
  let pageNo = 0;
  for (const sheet of sheets) {
    const rows = sheet.rows.filter((r) => r.some((c) => String(c ?? "").trim()));
    if (!rows.length) continue;
    pageNo++;
    const header = rows[0]!.map((c) => String(c ?? "").trim());
    const body = rows.slice(1).map((r) => r.map((c) => String(c ?? "").trim()));
    const blocks: Block[] = [
      { kind: "heading", text: sheet.name.trim() || `Sheet ${pageNo}`, level: 1 },
    ];
    const text = rows.map((r) => r.join(" | ")).join("\n");
    blocks.push({
      kind: "table",
      text,
      table: { header, rows: body, caption: sheet.name.trim() || undefined },
    });
    pages.push({ pageNo, blocks, source: "sheet" });
  }
  return {
    ...(meta.docId ? { docId: meta.docId } : {}),
    ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    fileName: meta.fileName,
    ...(meta.mime ? { mime: meta.mime } : {}),
    pageCount: pages.length,
    pages,
  };
}

// --- client-extracted pages → canonical --------------------------------------

export type PageText = { page: number; text: string };

/** Bridge for the synchronous ingest path: the browser pile already extracts
 *  page text, so map {page,text}[] to canonical para blocks (paragraph split),
 *  preserving the client's page numbers. No table structure at this level;
 *  scanned/complex docs get that via the BDA lane later. */
export function pagesToCanonical(pages: PageText[], meta: DocMeta): CanonicalDoc {
  const out: Page[] = [];
  for (const p of pages) {
    const text = (p.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const paras = text
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const blocks: Block[] = (paras.length ? paras : [text]).map((t) => ({ kind: "para", text: t }));
    out.push({ pageNo: p.page, blocks, source: "text" });
  }
  return {
    ...(meta.docId ? { docId: meta.docId } : {}),
    ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    fileName: meta.fileName,
    ...(meta.mime ? { mime: meta.mime } : {}),
    pageCount: out.length,
    pages: out,
  };
}

// --- plain text → canonical --------------------------------------------------

/** Paginate plain text into ~pageChars windows on paragraph boundaries; each
 *  page's paragraphs become para blocks. */
export function textToCanonical(text: string, meta: DocMeta, pageChars = 3000): CanonicalDoc {
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pages: Page[] = [];
  let pageNo = 0;
  let buf: string[] = [];
  let chars = 0;
  const flush = () => {
    if (!buf.length) return;
    pageNo++;
    pages.push({
      pageNo,
      blocks: buf.map((t) => ({ kind: "para", text: t }) as Block),
      source: "text",
    });
    buf = [];
    chars = 0;
  };
  for (const p of paras) {
    if (buf.length && chars + p.length > pageChars) flush();
    buf.push(p);
    chars += p.length + 2;
  }
  flush();
  if (!pages.length) pages.push({ pageNo: 1, blocks: [], source: "text" });
  return {
    ...(meta.docId ? { docId: meta.docId } : {}),
    ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    fileName: meta.fileName,
    ...(meta.mime ? { mime: meta.mime } : {}),
    pageCount: pages.length,
    pages,
  };
}
