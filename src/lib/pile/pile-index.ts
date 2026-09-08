import {
  addDoc,
  createIndex,
  pruneQueryTerms,
  removeDoc,
  search as bm25Search,
  tokenize,
  type Bm25Index,
} from "./bm25.ts";
import {
  ASK_CANDIDATES,
  ASK_PACK,
  HIT_SCORE_FLOOR,
  PER_FILE_ASK_PAGES,
  SEARCH_POOL_HITS,
  perFileHits,
} from "./limits.ts";
import { chunkText, collapsePassageHits } from "./passages.ts";
import {
  diversifyHits,
  expandNeighbors,
  expandQuery,
  looksCrossFile,
  roundRobinCover,
  samplePagesForStructure,
} from "./retrieve.ts";
import { isLowQualityText } from "./text-quality.ts";
import type { PileFileHits, PileFilePack, PileHit, PilePage, PileStructure } from "./types.ts";


/** Characters of page text shown per hit before the reader is opened. */
export const SNIPPET_CHARS = 380;

/**
 * The passage a hit shows: the window of the page that covers the most
 * distinct query terms (then the most occurrences), snapped outward to
 * sentence boundaries so it reads as prose rather than a cut mid-clause.
 * Falls back to the page opening when no term matches.
 */
export function snippet(text: string, query: string, max = SNIPPET_CHARS): string {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;
  const hay = raw.toLowerCase();
  // Anchor on the selective terms the ranker actually used, so a snippet never
  // centres on "the".
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    ),
  ];
  const positions: { at: number; term: number }[] = [];
  terms.forEach((term, index) => {
    let from = 0;
    for (let guard = 0; guard < 64; guard += 1) {
      const at = hay.indexOf(term, from);
      if (at < 0) break;
      positions.push({ at, term: index });
      from = at + term.length;
    }
  });
  positions.sort((a, b) => a.at - b.at);
  if (!positions.length) return `${raw.slice(0, max).replace(/\s+\S*$/, "")}`;

  // Best window: most distinct terms, then most hits, earliest on ties.
  let best = { start: Math.max(0, positions[0]!.at - 80), distinct: 0, count: 0 };
  for (let i = 0; i < positions.length; i += 1) {
    const start = Math.max(0, positions[i]!.at - 60);
    const end = start + max;
    const seen = new Set<number>();
    let count = 0;
    for (let j = i; j < positions.length && positions[j]!.at < end; j += 1) {
      seen.add(positions[j]!.term);
      count += 1;
    }
    if (seen.size > best.distinct || (seen.size === best.distinct && count > best.count)) {
      best = { start, distinct: seen.size, count };
    }
  }

  // Snap outward to sentence boundaries when one is close; otherwise to a word.
  let start = best.start;
  if (start > 0) {
    const boundary = raw.lastIndexOf(". ", start);
    start = boundary >= 0 && start - boundary <= 90 ? boundary + 2 : raw.indexOf(" ", start) + 1;
    if (start < 0 || start > best.start + 40) start = best.start;
  }
  let end = Math.min(raw.length, start + max);
  if (end < raw.length) {
    const boundary = raw.indexOf(". ", end - 90);
    end =
      boundary >= 0 && boundary + 1 <= end + 40 && boundary + 1 > start + max / 2
        ? boundary + 1
        : (() => {
            const space = raw.lastIndexOf(" ", end);
            return space > start + max / 2 ? space : end;
          })();
  }
  return raw.slice(start, end).trim();
}

export function pageToHit(page: PilePage, query: string, score: number): PileHit {
  return {
    fileId: page.fileId,
    fileName: page.fileName,
    page: page.page,
    score,
    snippet: snippet(page.text, query),
    garbled: isLowQualityText(page.text),
    ocr: page.ocr,
  };
}

/**
 * The whole pile lives here: the page store plus one incrementally maintained
 * BM25 index *per file*. Per-file indexes keep term statistics local, so a term
 * that is rare in a short exhibit is not devalued by a 5,000-page PDF, and every
 * file can report its own best passages instead of losing one pooled race.
 */
export class PileIndex {
  private pages: PilePage[] = [];
  private byKey = new Map<string, number>();
  private chunkCounts = new Map<string, number>();
  private indexes = new Map<string, Bm25Index>();
  private files = new Map<string, { name: string; pages: Set<number> }>();

  get size(): number {
    return this.pages.length;
  }

  clear(): void {
    this.pages = [];
    this.byKey = new Map();
    this.chunkCounts = new Map();
    this.indexes = new Map();
    this.files = new Map();
  }

  addPages(pages: PilePage[]): void {
    for (const page of pages) {
      const key = `${page.fileId}:${page.page}`;
      const existing = this.byKey.get(key);
      if (existing === undefined) {
        this.byKey.set(key, this.pages.length);
        this.pages.push(page);
      } else {
        this.pages[existing] = page;
      }
      const meta = this.files.get(page.fileId) ?? { name: page.fileName, pages: new Set<number>() };
      meta.name = page.fileName;
      meta.pages.add(page.page);
      this.files.set(page.fileId, meta);
      this.indexPage(page);
    }
  }

  /** Merge recovered OCR text into a page and reindex only that page. */
  updatePageText(fileId: string, page: number, text: string, ocr = true): boolean {
    const key = `${fileId}:${page}`;
    const i = this.byKey.get(key);
    if (i === undefined) return false;
    const prev = this.pages[i]!;
    const next = text.trim();
    if (next.length <= prev.text.length) return false;
    this.pages[i] = { ...prev, text: next, ocr };
    this.indexPage(this.pages[i]!);
    return true;
  }

  private indexFor(fileId: string): Bm25Index {
    let index = this.indexes.get(fileId);
    if (!index) {
      index = createIndex();
      this.indexes.set(fileId, index);
    }
    return index;
  }

  private indexPage(page: PilePage): void {
    const key = `${page.fileId}:${page.page}`;
    const index = this.indexFor(page.fileId);
    const previous = this.chunkCounts.get(key) ?? 0;
    for (let i = 0; i < previous; i += 1) removeDoc(index, `${key}:${i}`);
    const chunks = chunkText(page.text);
    if (!chunks.length) {
      addDoc(index, { id: `${key}:0`, text: `${page.fileName} p.${page.page}` });
      this.chunkCounts.set(key, 1);
      return;
    }
    chunks.forEach((chunk, i) => {
      addDoc(index, { id: `${key}:${i}`, text: `${page.fileName} p.${page.page} ${chunk}` });
    });
    this.chunkCounts.set(key, chunks.length);
  }

  /**
   * Run the query independently against every file. Each file returns its own
   * top hits (or `matched: false`), so no document is crowded out by volume.
   */
  searchByFile(
    query: string,
    perFileK = perFileHits(this.files.size),
    structure?: PileStructure | null,
  ): PileFileHits[] {
    const q = expandQuery(query, structure);
    const out: PileFileHits[] = [];
    for (const [fileId, meta] of this.files) {
      const index = this.indexes.get(fileId);
      let hits: PileHit[] = [];
      if (q.trim() && index) {
        // Snippets anchor on the terms the ranker kept, not on stopwords.
        const anchor = pruneQueryTerms(index, tokenize(q)).join(" ") || q;
        const ranked = collapsePassageHits(bm25Search(index, q, Math.max(perFileK * 10, 64)))
          .map((hit) => {
            const i = this.byKey.get(hit.pageId);
            const page = i === undefined ? undefined : this.pages[i];
            return page ? pageToHit(page, anchor, hit.score) : null;
          })
          .filter((h): h is PileHit => !!h);
        // Relevance floor: a file with three real matches returns three, not a
        // padded list of near-zero-score pages.
        const top = ranked[0]?.score ?? 0;
        hits = ranked.filter((h) => h.score >= top * HIT_SCORE_FLOOR).slice(0, perFileK);
      }
      out.push({
        fileId,
        fileName: meta.name,
        pageCount: meta.pages.size,
        matched: hits.length > 0,
        topScore: hits[0]?.score ?? 0,
        hits,
      });
    }
    return out.sort((a, b) => b.topScore - a.topScore || a.fileName.localeCompare(b.fileName));
  }

  /** Per-file retrieval packs (hits plus neighbor-expanded page text) for Ask. */
  packAskByFile(
    query: string,
    structure?: PileStructure | null,
    perFileK = perFileHits(this.files.size),
    perFileCap = PER_FILE_ASK_PAGES,
  ): PileFilePack[] {
    const groups = this.searchByFile(query, perFileK, structure);
    return groups.map((group) => {
      let hits = group.hits;
      if (!hits.length) {
        const own = this.pages.filter((p) => p.fileId === group.fileId && p.text.trim());
        hits = own.slice(0, Math.min(2, perFileCap)).map((p, i) => pageToHit(p, query, 1 / (i + 1)));
      }
      const catalog = hits.flatMap((h) => this.neighborsOf(h.fileId, h.page, 1));
      const expanded = expandNeighbors(hits, catalog, 1).slice(0, perFileCap);
      return { ...group, hits: expanded, pages: this.pagesFor(expanded) };
    });
  }

  /** Pooled ranking, assembled by merging the per-file passes. */
  search(query: string, k = SEARCH_POOL_HITS, structure?: PileStructure | null): PileHit[] {
    if (!query.trim() || !this.pages.length) return [];
    const ranked = this.searchByFile(
      query,
      Math.max(k, perFileHits(this.files.size)),
      structure,
    )
      .flatMap((g) => g.hits)
      .sort((a, b) => b.score - a.score);
    return looksCrossFile(query) ? diversifyHits(ranked, k, 6) : diversifyHits(ranked, k, 12);
  }

  cover(k: number): PileHit[] {
    const readable = this.pages.filter((p) => p.text.trim());
    return roundRobinCover(readable, k).map((page, i) => pageToHit(page, "", 1 / (i + 1)));
  }

  /** Retrieval pack for Ask: ranked hits plus the page text the model will read. */
  packAsk(
    query: string,
    structure?: PileStructure | null,
    k = ASK_CANDIDATES,
    cap = ASK_PACK,
  ): { hits: PileHit[]; pages: PilePage[] } {
    let hits = this.search(query, k, structure);
    if (!hits.length) hits = this.cover(k);
    const catalog = hits.flatMap((h) => this.neighborsOf(h.fileId, h.page, 1));
    const expanded = expandNeighbors(hits, catalog, 1).slice(0, cap);
    return { hits: expanded, pages: this.pagesFor(expanded) };
  }


  private neighborsOf(fileId: string, page: number, radius: number): PileHit[] {
    const out: PileHit[] = [];
    for (let d = -radius; d <= radius; d += 1) {
      const i = this.byKey.get(`${fileId}:${page + d}`);
      if (i === undefined) continue;
      out.push(pageToHit(this.pages[i]!, "", 0));
    }
    return out;
  }

  pagesFor(hits: { fileId: string; page: number }[]): PilePage[] {
    return hits
      .map((h) => this.byKey.get(`${h.fileId}:${h.page}`))
      .filter((i): i is number => i !== undefined)
      .map((i) => this.pages[i]!);
  }

  /** Small text map for just the hits on screen — never the whole corpus. */
  textsFor(hits: { fileId: string; page: number }[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const page of this.pagesFor(hits)) {
      out[`${page.fileId}:${page.page}`] = page.text;
      out[`${page.fileName}:${page.page}`] = page.text;
    }
    return out;
  }

  structureSample(maxPerFile = 8): { fileName: string; page: number; text: string }[] {
    return samplePagesForStructure(this.pages, maxPerFile).map((p) => ({
      fileName: p.fileName,
      page: p.page,
      text: p.text,
    }));
  }
}
