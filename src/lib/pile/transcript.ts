import { isLowQualityText } from "./text-quality.ts";
import type { PilePage } from "./types.ts";

export type TranscriptSpeaker = "Q" | "A" | "COURT" | "COUNSEL" | "WITNESS" | "OTHER";

export type TranscriptLine = {
  page: number;
  line: number;
  speaker: TranscriptSpeaker;
  speakerLabel: string;
  text: string;
};

export type TranscriptBlock = {
  id: string;
  startPage: number;
  startLine: number;
  endPage: number;
  endLine: number;
  cite: string;
  question: string;
  answer: string;
  lines: TranscriptLine[];
};

export type TranscriptParse = {
  fileName: string;
  citeReady: boolean;
  caption: string;
  witness: string | null;
  lines: TranscriptLine[];
  blocks: TranscriptBlock[];
};

const QA_LINE = /^\s*(?:\d{1,2}[.)]?\s+)?[QA](?:\s*\.|\s*:)\s/im;
const LINED_QA = /^\s*\d{1,2}[.)]?\s+[QA](?:\s*\.|\s*:)\s/im;
const DEP_HINT =
  /deposition of|sworn\s+(?:duly\s+)?and|called as a witness|examination by|direct examination|cross-examination|the witness:/i;

function shouldSkipLine(s: string): boolean {
  const t = s.trim();
  if (!t || /deposition of/i.test(t)) return false;
  if (/^(confidential|attorney.?s eyes only|highly confidential)\s*$/i.test(t)) return true;
  if (/^page\s+\d+\s+of\s+\d+$/i.test(t)) return true;
  if (/^(videotaped deposition|reported by|job no\.)/i.test(t) && t.length < 80) return true;
  if (/^whereupon,?\s/i.test(t) || /^\[reporter/i.test(t)) return true;
  return false;
}

export function normalizeTranscriptText(raw: string): string {
  let t = (raw ?? "").replace(/\r\n/g, "\n");
  t = t.replace(/\u00a0/g, " ");
  t = t.replace(/[QA]\s*[.]\s*/g, (m) => `${m[0]!.toUpperCase()}. `);
  t = t.replace(/[QA]\s*:\s+/g, (m) => `${m[0]!.toUpperCase()}. `);
  t = t.replace(/(^|\n)(\s*)(\d{1,2})(?=[QA]\.)/g, "$1$2$3 ");
  t = t.replace(/(^|\n)(\s*)(\d{1,2})\s*[.)]\s+(?=[QA]\.)/g, "$1$2$3 ");
  t = t
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (shouldSkipLine(s)) return false;
      return true;
    })
    .join("\n");
  return t;
}

export function pageNeedsDepOcr(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (looksLikeTranscript(t)) return false;
  // Caption / appearances / cert pages are real text without Q&A — do not VL them.
  return isLowQualityText(t);
}

export function looksLikeTranscript(text: string): boolean {
  const raw = normalizeTranscriptText(text ?? "");
  if (raw.length < 40) return false;
  const qa = raw.match(/^\s*(?:\d{1,2}[.)]?\s+)?[QA](?:\s*\.|\s*:)\s/gim)?.length ?? 0;
  const lined = raw.match(/^\s*\d{1,2}[.)]?\s+[QA](?:\s*\.|\s*:)\s/gim)?.length ?? 0;
  if (lined >= 3) return true;
  if (qa >= 4 && DEP_HINT.test(raw)) return true;
  return qa >= 8;
}

export function formatCite(startPage: number, startLine: number, endPage: number, endLine: number): string {
  if (startPage === endPage && startLine === endLine) return `${startPage}:${startLine}`;
  return `${startPage}:${startLine}-${endPage}:${endLine}`;
}

function classifySpeaker(label: string): TranscriptSpeaker {
  const u = label.toUpperCase();
  if (u.startsWith("Q")) return "Q";
  if (u.startsWith("A")) return "A";
  if (/WITNESS/.test(u)) return "WITNESS";
  if (/COURT/.test(u)) return "COURT";
  if (/^M[RS]S?\.\s/.test(u) || /COUNSEL/.test(u) || /^BY\s/.test(u)) return "COUNSEL";
  return "OTHER";
}

function parseSpeaker(rest: string): { speaker: TranscriptSpeaker; speakerLabel: string; text: string } {
  const cleaned = rest.replace(/^\s+/, "");
  const q = cleaned.match(/^Q\.?\s+(.*)$/i);
  if (q) return { speaker: "Q", speakerLabel: "Q", text: (q[1] ?? "").trim() };
  const a = cleaned.match(/^A\.?\s+(.*)$/i);
  if (a) return { speaker: "A", speakerLabel: "A", text: (a[1] ?? "").trim() };
  const by = cleaned.match(/^(BY\s+[A-Z][A-Z .,'-]{1,40}:)\s*(.*)$/i);
  if (by) {
    const label = by[1]!.replace(/\s+/g, " ").trim();
    return { speaker: "COUNSEL", speakerLabel: label, text: (by[2] ?? "").trim() };
  }
  const named = cleaned.match(/^((?:THE\s+)?[A-Z][A-Z .,'-]{1,40}:)\s*(.*)$/);
  if (named) {
    const label = named[1]!.replace(/\s+/g, " ").trim();
    return { speaker: classifySpeaker(label), speakerLabel: label, text: (named[2] ?? "").trim() };
  }
  return { speaker: "OTHER", speakerLabel: "", text: cleaned.trim() };
}

function isPageHeader(raw: string, lastLineNo: number): number | null {
  const pageWord = raw.match(/^\s*Page\s+(\d{1,4})\b/i);
  if (pageWord) return Number(pageWord[1]);
  const dashed = raw.match(/^\s*-{2,}\s*(\d{1,4})\s*-{2,}\s*$/);
  if (dashed) return Number(dashed[1]);
  const lonely = raw.match(/^\s{6,}(\d{1,4})\s*$/);
  if (lonely) return Number(lonely[1]);
  const only = raw.match(/^\s*(\d{1,4})\s*$/);
  if (only) {
    const n = Number(only[1]);
    if (n >= 1 && (n > 28 || lastLineNo === 0 || lastLineNo >= 20)) return n;
  }
  return null;
}

function parseNumbered(text: string, defaultPage = 0): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let page = defaultPage;
  let lastLineNo = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (shouldSkipLine(raw)) continue;
    const header = isPageHeader(raw, lastLineNo);
    if (header != null && !/^\s*\d{1,2}[.)]?\s+[QA]\./i.test(raw)) {
      const numberedEmpty = raw.match(/^\s*(\d{1,2})\s+$/);
      if (numberedEmpty && lastLineNo > 0 && Number(numberedEmpty[1]) === lastLineNo + 1) {
        /* fall through — a blank spoken line */
      } else {
        page = header;
        lastLineNo = 0;
        continue;
      }
    }
    const numbered = raw.match(/^\s*(\d{1,2})[.)]?\s{1,}(.*)$/);
    if (numbered) {
      const n = Number(numbered[1]);
      const rest = (numbered[2] ?? "").trim();
      if (!rest) {
        if (n > 28 || lastLineNo === 0) {
          page = n;
          lastLineNo = 0;
        }
        continue;
      }
      if (n >= 1 && n <= 50) {
        const { speaker, speakerLabel, text: body } = parseSpeaker(rest);
        if (!body && speaker === "OTHER") continue;
        out.push({ page: page || defaultPage || 1, line: n, speaker, speakerLabel, text: body });
        lastLineNo = n;
        if (!page) page = defaultPage || 1;
        continue;
      }
    }
    if (out.length && raw.trim()) {
      const last = out[out.length - 1]!;
      last.text = `${last.text} ${raw.trim()}`.trim();
    }
  }
  return out;
}

function parseQaProse(text: string, defaultPage = 1): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let line = 0;
  let buf = "";
  let speaker: TranscriptSpeaker = "OTHER";
  let speakerLabel = "";
  const flush = () => {
    const body = buf.replace(/\s+/g, " ").trim();
    if (!body) return;
    line += 1;
    out.push({ page: defaultPage, line, speaker, speakerLabel, text: body });
    buf = "";
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (shouldSkipLine(raw)) continue;
    const start = raw.match(/^\s*([QA])(?:\s*\.|\s*:)\s+(.*)$/i);
    if (start) {
      flush();
      speaker = start[1]!.toUpperCase() === "Q" ? "Q" : "A";
      speakerLabel = speaker;
      buf = start[2] ?? "";
      continue;
    }
    const named = raw.match(/^\s*((?:THE\s+)?[A-Z][A-Z .,'-]{1,40}:)\s*(.*)$/);
    if (named && /WITNESS|COURT|^M[RS]S?\./i.test(named[1]!)) {
      flush();
      const parsed = parseSpeaker(`${named[1]} ${named[2] ?? ""}`);
      speaker = parsed.speaker;
      speakerLabel = parsed.speakerLabel;
      buf = parsed.text;
      continue;
    }
    if (buf) buf += ` ${raw.trim()}`;
  }
  flush();
  return out;
}

function captionOf(text: string): string {
  const cut = text.search(QA_LINE);
  const head = (cut >= 0 ? text.slice(0, cut) : text.slice(0, 800)).replace(/\s+/g, " ").trim();
  return head.slice(0, 500);
}

function witnessOf(caption: string, fileName: string): string | null {
  const m = caption.match(/deposition of\s+(.+?)(?:\s+taken\b|\s+deposed\b|,|\n|$)/i);
  if (m) return m[1]!.replace(/\s+/g, " ").trim().slice(0, 80);
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base || null;
}

function groupBlocks(lines: TranscriptLine[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let cur: TranscriptLine[] = [];
  const push = () => {
    if (!cur.length) return;
    const qParts = cur.filter((l) => l.speaker === "Q").map((l) => l.text);
    const aParts = cur
      .filter((l) => l.speaker !== "Q")
      .map((l) => (l.speakerLabel && l.speaker !== "A" ? `${l.speakerLabel} ${l.text}` : l.text));
    const first = cur[0]!;
    const last = cur[cur.length - 1]!;
    blocks.push({
      id: `${first.page}:${first.line}`,
      startPage: first.page,
      startLine: first.line,
      endPage: last.page,
      endLine: last.line,
      cite: formatCite(first.page, first.line, last.page, last.line),
      question: qParts.join(" ").trim(),
      answer: aParts.join(" ").trim(),
      lines: cur,
    });
    cur = [];
  };
  for (const line of lines) {
    if (line.speaker === "Q" && cur.some((l) => l.speaker === "A" || (l.speaker !== "Q" && l.text))) {
      push();
    }
    cur.push(line);
  }
  push();
  return blocks.filter((b) => b.question || b.answer);
}

function fallbackLines(pages: { page: number; text: string }[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const p of pages) {
    const chunks = normalizeTranscriptText(p.text ?? "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !shouldSkipLine(s));
    chunks.forEach((text, i) => {
      const { speaker, speakerLabel, text: body } = parseSpeaker(text.replace(/^\d{1,2}[.)]?\s+/, ""));
      lines.push({ page: p.page, line: i + 1, speaker, speakerLabel, text: body || text });
    });
  }
  return lines;
}

function citeReadyOf(lines: TranscriptLine[]): boolean {
  const byPage = new Map<number, number[]>();
  for (const l of lines) {
    const list = byPage.get(l.page) ?? [];
    list.push(l.line);
    byPage.set(l.page, list);
  }
  let numberedPages = 0;
  for (const nums of byPage.values()) {
    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    if (uniq.length >= 2) numberedPages += 1;
    let run = 1;
    for (let i = 1; i < uniq.length; i++) {
      run = uniq[i] === uniq[i - 1]! + 1 ? run + 1 : 1;
      if (run >= 4) return true;
    }
  }
  return numberedPages >= 2 && lines.some((l) => l.page > 1);
}

export function transcriptFromPages(
  pages: { page: number; text: string }[],
  fileName = "transcript.txt",
): TranscriptParse {
  const cleaned = pages.map((p) => ({ page: p.page, text: normalizeTranscriptText(p.text ?? "") }));
  const lines: TranscriptLine[] = [];
  let caption = "";
  for (const p of cleaned) {
    if (!caption) caption = captionOf(p.text);
    const lined = p.text.match(new RegExp(LINED_QA.source, "gim"))?.length ?? 0;
    const part =
      lined >= 2 ? parseNumbered(`                                                                ${p.page}\n${p.text}`, p.page) : parseQaProse(p.text, p.page);
    if (part.length) lines.push(...part);
  }
  const used = lines.length ? lines : fallbackLines(cleaned);
  return {
    fileName,
    citeReady: citeReadyOf(used),
    caption: caption || (cleaned[0]?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    witness: witnessOf(caption || `${cleaned[0]?.text ?? ""} ${fileName}`, fileName),
    lines: used,
    blocks: groupBlocks(used),
  };
}

export function parseTranscript(text: string, fileName = "transcript.txt"): TranscriptParse {
  const raw = normalizeTranscriptText(text ?? "");
  const lined = raw.match(new RegExp(LINED_QA.source, "gim"))?.length ?? 0;
  const lines = lined >= 3 ? parseNumbered(raw) : parseQaProse(raw);
  const caption = captionOf(raw);
  return {
    fileName,
    citeReady: lined >= 4 && citeReadyOf(lines),
    caption,
    witness: witnessOf(caption, fileName),
    lines,
    blocks: groupBlocks(lines),
  };
}

export function blocksToPages(parsed: TranscriptParse, fileId: string, fileName: string): PilePage[] {
  const byPage = new Map<number, string[]>();
  for (const block of parsed.blocks) {
    const chunk = `Q. ${block.question}\nA. ${block.answer}`.trim();
    const list = byPage.get(block.startPage) ?? [];
    list.push(chunk);
    byPage.set(block.startPage, list);
  }
  if (!byPage.size) {
    for (const line of parsed.lines) {
      const list = byPage.get(line.page) ?? [];
      list.push(line.text);
      byPage.set(line.page, list);
    }
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, parts]) => ({
      fileId,
      fileName,
      page,
      text: parts.join("\n\n"),
      ocr: false,
    }));
}

export function pagesToTranscriptText(pages: { page: number; text: string }[]): string {
  return pages
    .map((p) => {
      const printed = p.text.match(/^\s*Page\s+(\d{1,4})\b/im);
      const num = printed ? printed[1] : String(p.page);
      return `                                                                ${num}\n${normalizeTranscriptText(p.text)}`;
    })
    .join("\n");
}

export function sampleDigestBlocks(
  blocks: TranscriptBlock[],
  focus: string,
  cap = 24,
  bias: string[] = [],
): TranscriptBlock[] {
  if (!blocks.length) return [];
  if (blocks.length <= cap) return blocks;
  const picked = new Map<string, TranscriptBlock>();
  const add = (b: TranscriptBlock | undefined) => {
    if (!b || picked.has(b.id)) return;
    picked.set(b.id, b);
  };
  for (let i = 0; i < Math.min(3, blocks.length); i++) add(blocks[i]);
  for (let i = Math.max(0, blocks.length - 2); i < blocks.length; i++) add(blocks[i]);
  const terms = [
    ...focus
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
    ...bias.map((t) => t.toLowerCase()),
  ];
  if (terms.length) {
    for (const b of blocks) {
      if (picked.size >= cap) break;
      const hay = `${b.question} ${b.answer}`.toLowerCase();
      if (terms.some((t) => hay.includes(t))) add(b);
    }
  }
  const extra = Math.max(0, cap - picked.size);
  if (extra) {
    for (let n = 1; n <= extra; n++) {
      add(blocks[Math.round((n / (extra + 1)) * (blocks.length - 1))]);
    }
  }
  return [...picked.values()].sort((a, b) => a.startPage - b.startPage || a.startLine - b.startLine).slice(0, cap);
}
