// Structure-aware, table-aware, page-anchored chunking of a CanonicalDoc.
// Pure + deterministic (no model calls, no I/O) so it is unit-testable and can
// run in a bounded parallel pass. The contextual-retrieval prefix (a one-line
// model-generated summary) is added later at embed time; here we capture the
// deterministic heading path so that step has context to work from.
//
// Rules (see docs/kb-ingest-design.md):
//  - Prose (para/list) is grouped into ~target-sized chunks with a small overlap
//    WITHIN a section + page only. Headings, page breaks, tables and figures are
//    hard boundaries (flush, no overlap carried across them).
//  - Each table is its own chunk; a large table is split into row-groups with the
//    header row repeated in each so every chunk is self-describing.
//  - Page is the citation anchor; prose chunks never span pages (pageStart ===
//    pageEnd). Content is capped well under the Data API 64 KB/row limit.

import type { Block, CanonicalDoc } from "./canonical";

export type KbChunkInput = {
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  kind: "para" | "table" | "figure";
  content: string;
  /** Nearest heading path, deterministic context for the embed-time enrichment. */
  headingPath: string;
  tokenCount: number;
};

export type ChunkOptions = {
  /** Target prose chunk size in chars (~4 chars/token). */
  targetChars?: number;
  /** Overlap carried between consecutive prose chunks in the same section+page. */
  overlapChars?: number;
  /** Max chars per table row-group chunk. */
  tableGroupChars?: number;
  /** Hard per-chunk ceiling (Data API row cap is 64 KB; stay under it). */
  maxChunkChars?: number;
};

const DEFAULTS = {
  targetChars: 2000,
  overlapChars: 300,
  tableGroupChars: 4000,
  maxChunkChars: 60000,
};

const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Last `n` chars, trimmed forward to a word boundary. */
function overlapTail(s: string, n: number): string {
  if (n <= 0 || s.length <= n) return "";
  const tail = s.slice(-n);
  const sp = tail.indexOf(" ");
  return (sp > 0 ? tail.slice(sp + 1) : tail).trim();
}

export function chunkDocument(doc: CanonicalDoc, opts: ChunkOptions = {}): KbChunkInput[] {
  const targetChars = opts.targetChars ?? DEFAULTS.targetChars;
  const overlapChars = opts.overlapChars ?? DEFAULTS.overlapChars;
  const tableGroupChars = opts.tableGroupChars ?? DEFAULTS.tableGroupChars;
  const maxChunkChars = opts.maxChunkChars ?? DEFAULTS.maxChunkChars;

  const chunks: KbChunkInput[] = [];
  let idx = 0;
  let heading = "";

  const push = (content: string, page: number, kind: KbChunkInput["kind"]): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Safety split so no single chunk exceeds the per-row cap.
    for (let s = 0; s < trimmed.length; s += maxChunkChars) {
      const part = trimmed.slice(s, s + maxChunkChars);
      chunks.push({
        chunkIndex: idx++,
        pageStart: page,
        pageEnd: page,
        kind,
        content: part,
        headingPath: heading,
        tokenCount: estTokens(part),
      });
    }
  };

  // Prose accumulator (single page + section by construction).
  let buf = "";
  let bufPage = 0;
  const flushProse = (): void => {
    if (buf.trim()) push(buf, bufPage, "para");
    buf = "";
  };

  const emitTable = (b: Block, page: number): void => {
    const t = b.table;
    if (!t || !t.header.length) {
      push(b.text, page, "table");
      return;
    }
    const header = `| ${t.header.join(" | ")} |`;
    const sep = `| ${t.header.map(() => "---").join(" | ")} |`;
    const cap = t.caption ? `${t.caption.trim()}\n` : "";
    const prefix = `${cap}${header}\n${sep}`;
    let group: string[] = [];
    let groupChars = prefix.length;
    const flushGroup = (): void => {
      if (!group.length) return;
      push(`${prefix}\n${group.join("\n")}`, page, "table");
      group = [];
      groupChars = prefix.length;
    };
    for (const row of t.rows) {
      const rowStr = `| ${row.join(" | ")} |`;
      if (group.length && groupChars + rowStr.length + 1 > tableGroupChars) flushGroup();
      group.push(rowStr);
      groupChars += rowStr.length + 1;
    }
    flushGroup();
  };

  for (const pg of doc.pages) {
    for (const b of pg.blocks) {
      if (b.kind === "heading") {
        flushProse();
        heading = b.text.trim();
        continue;
      }
      if (b.kind === "table") {
        flushProse();
        emitTable(b, pg.pageNo);
        continue;
      }
      if (b.kind === "figure") {
        flushProse();
        push(b.text, pg.pageNo, "figure");
        continue;
      }
      // para | list
      const piece = b.text.trim();
      if (!piece) continue;
      bufPage = pg.pageNo;
      if (buf && buf.length + 1 + piece.length > targetChars) {
        const flushed = buf;
        push(flushed, bufPage, "para");
        const tail = overlapTail(flushed, overlapChars);
        buf = tail ? `${tail} ${piece}` : piece;
      } else {
        buf = buf ? `${buf}\n${piece}` : piece;
      }
    }
    // Page break is a hard boundary: prose never spans pages.
    flushProse();
  }
  flushProse();

  return chunks;
}
