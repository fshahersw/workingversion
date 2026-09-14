// Deterministic retrieval-budget rules for the saved-set RAG Ask.
//
// Pure and dependency-free so it loads under `node --test` without the @/ alias.
// Given the documents in a saved set, decide how many chunks to retrieve from
// each — a floor per document, scaled up by document size (pages/rows) and file
// type, then capped both per-document and by a global ceiling so a large set
// never blows the writer's context or the concurrent Bedrock/Aurora budget.

/** Floor on chunks retrieved per document (holds until the global cap binds). */
export const RAG_MIN_CHUNKS_PER_DOC = 12;
/** Ceiling on chunks per document before the global cap is applied. */
export const RAG_MAX_CHUNKS_PER_DOC = 40;
/** One extra chunk above the floor per this many pages (document-size scaling). */
export const RAG_PAGES_PER_EXTRA_CHUNK = 15;
/** Total chunks across all selected documents — bounds Aurora work + writer size. */
export const RAG_GLOBAL_CHUNK_CAP = 120;
/** Packed-evidence ceiling for the saved-set RAG writer (generous; Sonnet-5 has a 200k ctx). */
export const RAG_PACK_CHARS = 320000;

/** Tabular/spreadsheet types are chunk-dense; give them a modest multiplier. */
const TABULAR_EXT = new Set(["xlsx", "xls", "csv", "tsv"]);

export type RagRetrievalDoc = {
  docId: string;
  fileName: string;
  pageCount: number;
  /** Total chunks that exist for this doc; caps the request (can't retrieve more than exist). */
  chunkCount?: number;
};

export type RagDocPlan = { docId: string; k: number };

function extensionOf(fileName: string): string {
  const m = /\.([a-z0-9]+)\s*$/i.exec(fileName || "");
  return m ? m[1]!.toLowerCase() : "";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Chunks to retrieve for one document, before the global cap: floor + size bonus,
 * scaled by a file-type multiplier, clamped to [floor, max], and never more than
 * the chunks that actually exist for the document.
 */
export function chunksForDoc(doc: RagRetrievalDoc): number {
  const pages = Number.isFinite(doc.pageCount) ? Math.max(0, doc.pageCount) : 0;
  const sizeBonus = Math.floor(pages / RAG_PAGES_PER_EXTRA_CHUNK);
  const mult = TABULAR_EXT.has(extensionOf(doc.fileName)) ? 1.25 : 1;
  let k = clamp(
    Math.ceil((RAG_MIN_CHUNKS_PER_DOC + sizeBonus) * mult),
    RAG_MIN_CHUNKS_PER_DOC,
    RAG_MAX_CHUNKS_PER_DOC,
  );
  if (typeof doc.chunkCount === "number" && Number.isFinite(doc.chunkCount) && doc.chunkCount > 0) {
    k = Math.min(k, doc.chunkCount);
  }
  return Math.max(1, k);
}

/**
 * Per-document retrieval plan for a whole set. Each document gets `chunksForDoc`;
 * if the total exceeds `cap`, every document is shrunk proportionally (floor 1)
 * and any rounding drift is trimmed from the largest requests first, so the plan
 * sums to at most `cap` while staying deterministic.
 */
export function planRetrieval(
  docs: RagRetrievalDoc[],
  cap: number = RAG_GLOBAL_CHUNK_CAP,
): RagDocPlan[] {
  const want: RagDocPlan[] = docs.map((d) => ({ docId: d.docId, k: chunksForDoc(d) }));
  const total = want.reduce((sum, p) => sum + p.k, 0);
  if (total <= cap || total === 0) return want;

  const scaled: RagDocPlan[] = want.map((p) => ({
    docId: p.docId,
    k: Math.max(1, Math.round((p.k * cap) / total)),
  }));
  // Trim rounding overshoot from the largest requests first; never below 1.
  let drift = scaled.reduce((sum, p) => sum + p.k, 0) - cap;
  const largestFirst = [...scaled].sort((a, b) => b.k - a.k);
  let guard = 0;
  const maxIterations = drift + scaled.length + 1;
  while (drift > 0 && guard < maxIterations * 4) {
    let trimmed = false;
    for (const p of largestFirst) {
      if (drift <= 0) break;
      if (p.k > 1) {
        p.k -= 1;
        drift -= 1;
        trimmed = true;
      }
    }
    if (!trimmed) break; // everything is at the floor of 1
    guard++;
  }
  return scaled;
}
