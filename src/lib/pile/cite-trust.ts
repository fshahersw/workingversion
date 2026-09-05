import { quoteOnPage } from "../review/pipeline-core.ts";
import type { PileHit, PilePage } from "./types.ts";

export type CitePage = {
  ref: string;
  fileId: string;
  fileName: string;
  page: number;
  text: string;
  ocr?: boolean;
  garbled?: boolean;
};

export type CiteCheck = {
  ref: string;
  fileId: string;
  fileName: string;
  page: number;
  label: string;
  quote: string;
  match: "exact" | "normalized" | "fuzzy" | "none" | "packed";
  ocr: boolean;
  garbled: boolean;
};

export type CiteReport = {
  cites: CiteCheck[];
  verified: number;
  unverified: number;
  ocrUsed: boolean;
  garbledUsed: boolean;
  pagesRead: number;
  filesRead: number;
  filesTotal: number;
};

export function shortFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  if (base.length <= 28) return base;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
  return `${base.slice(0, 22 - ext.length)}…${ext}`;
}

export function citeLabel(fileName: string, page: number): string {
  return `${shortFileName(fileName)} p. ${page}`;
}

export function pagesFromPack(
  pages: PilePage[],
  hits: PileHit[] = [],
): CitePage[] {
  const garbled = new Set(
    hits.filter((h) => h.garbled).map((h) => `${h.fileId}:${h.page}`),
  );
  return pages.map((p, i) => ({
    ref: `S${i + 1}`,
    fileId: p.fileId,
    fileName: p.fileName,
    page: p.page,
    text: p.text,
    ocr: p.ocr,
    garbled: garbled.has(`${p.fileId}:${p.page}`),
  }));
}

export function citeLabelMap(pages: CitePage[]): Record<string, string> {
  return Object.fromEntries(pages.map((p) => [p.ref, citeLabel(p.fileName, p.page)]));
}

/** Quoted span immediately before [Sn], else a distinctive window from that line. */
export function claimNearCite(answer: string, ref: string): string {
  const token = `[${ref}]`;
  const idx = answer.indexOf(token);
  if (idx < 0) return "";
  const start = Math.max(0, answer.lastIndexOf("\n", idx));
  const nextBreak = answer.indexOf("\n", idx);
  const end = nextBreak === -1 ? answer.length : nextBreak;
  const before = answer.slice(start, idx);
  const quotes = [...before.matchAll(/[“"]([^”"]{12,400})[”"]/g)].map((m) => m[1]!.trim());
  if (quotes.length) return quotes[quotes.length - 1]!;
  const sentence = answer.slice(start, end).replace(/\[S\d+\]/g, " ").replace(/[*_`#]/g, " ");
  return sentence.replace(/\s+/g, " ").trim().slice(0, 280);
}

export function verifyAnswerCites(answer: string, pages: CitePage[]): CiteReport {
  const byRef = new Map(pages.map((p) => [p.ref, p]));
  const seen = new Set<string>();
  const cites: CiteCheck[] = [];
  for (const m of answer.matchAll(/\[S(\d+)\]/g)) {
    const ref = `S${m[1]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const page = byRef.get(ref);
    if (!page) {
      cites.push({
        ref,
        fileId: "",
        fileName: "",
        page: 0,
        label: ref,
        quote: "",
        match: "none",
        ocr: false,
        garbled: false,
      });
      continue;
    }
    const quote = claimNearCite(answer, ref);
    const match = quote.length >= 12 ? quoteOnPage(quote, page.text) : "packed";
    cites.push({
      ref,
      fileId: page.fileId,
      fileName: page.fileName,
      page: page.page,
      label: citeLabel(page.fileName, page.page),
      quote,
      match: match === "none" && quote.length < 12 ? "packed" : match,
      ocr: !!page.ocr,
      garbled: !!page.garbled,
    });
  }
  const files = new Set(pages.map((p) => p.fileId));
  return {
    cites,
    verified: cites.filter((c) => c.match !== "none").length,
    unverified: cites.filter((c) => c.match === "none").length,
    ocrUsed: pages.some((p) => p.ocr) || cites.some((c) => c.ocr),
    garbledUsed: pages.some((p) => p.garbled) || cites.some((c) => c.garbled),
    pagesRead: pages.length,
    filesRead: files.size,
    filesTotal: files.size,
  };
}

export function rewriteCites(answer: string, pages: CitePage[]): string {
  const map = citeLabelMap(pages);
  return answer.replace(/\[S(\d+)\]/g, (full, n: string) => {
    const label = map[`S${n}`];
    return label ? `[${label}]` : full;
  });
}
