/** Whole-session page budget. The pile lives in a worker, so this is memory-bound. */
export const MAX_PAGES = 20000;
/** No single file may consume the entire session budget. */
export const MAX_PAGES_PER_FILE = 8000;
export const MAX_BYTES = 150 * 1024 * 1024;
export const MAX_FILES = 120;
/** VL OCR only on empty/noisy pages. Page cap is independent of in-flight parallelism. */
export const OCR_PAGE_CAP = 1500;
/** Ceiling on any one file's share of the OCR budget, so file 1 can't starve file 12. */
export const OCR_MAX_PER_FILE = 400;
export const PDF_PAGE_CONCURRENCY = 8;
export const FILE_EXTRACT_CONCURRENCY = 4;
/** Rough decoded-bytes ceiling for files being read at once. */
export const READ_BYTES_IN_FLIGHT = 120 * 1024 * 1024;
/**
 * Start / floor / ceiling for in-flight Nano VL calls (AIMD). Kept deliberately
 * small: a wide pipe of large image posts is what tripped
 * ERR_SSL_BAD_RECORD_MAC_ALERT on the shared TLS connection.
 */
export const OCR_CONCURRENCY = 4;
export const OCR_CONCURRENCY_MIN = 2;
export const OCR_CONCURRENCY_MAX = 6;
/** A page with less extracted text than this has no usable text layer -> OCR it. */
export const OCR_EMPTY_CHARS = 120;
/** Spreadsheet rows per synthetic page, so a 40k-row sheet is not one retrieval unit. */
export const XLSX_ROWS_PER_PAGE = 60;
/** Characters per synthetic Word page when a section has no headings to split on. */
export const DOC_CHARS_PER_PAGE = 3000;
export const EMBED_CONCURRENCY = 6;
export const RENDER_CONCURRENCY = 4;
export const ASK_CANDIDATES = 16;
export const ASK_PACK = 14;
/** Per-file fan-out: baseline hits returned from each file's own index. */
export const PER_FILE_HITS = 6;
/** Pages packed per file for the per-file reader stage. */
export const PER_FILE_ASK_PAGES = 15;
/** Floor on cited pages surfaced by any Ask, single-file piles included. */
export const ASK_MIN_HITS = 15;
/** Files that get their own reader call before synthesis. */
export const MAX_FANOUT_FILES = 30;
/** Concurrent per-file reader calls. */
export const FILE_DIGEST_CONCURRENCY = 8;
/** Total pages handed to the cross-file writer. */
export const MULTI_ASK_PAGES = 28;
/** Pooled hits shown for a keyword search. */
export const SEARCH_POOL_HITS = 20;
/**
 * A hit scoring below this fraction of its own file's best score is noise —
 * dropped so a wider budget never pads the list with junk.
 */
export const HIT_SCORE_FLOOR = 0.25;

/**
 * Hits pulled from each file's own index, scaled to pile size: a single file
 * can afford deep coverage, a 40-file pile stays lean per file and gets its
 * breadth from running every file in parallel.
 */
export function perFileHits(fileCount: number): number {
  if (fileCount <= 1) return 20;
  if (fileCount <= 5) return 10;
  if (fileCount <= 12) return 6;
  return 4;
}

/**
 * Hard ceiling on packed-evidence characters handed to a writer call
 * (~65k tokens at ~4 chars/token). Page budgets below are always trimmed
 * against this ceiling so the writer never overflows its context.
 */
export const ASK_PACK_CHARS = 260000;

export type AskBudget = {
  /** Pages packed for a single-file ask. */
  singlePack: number;
  /** Pages packed per file in the fan-out stage. */
  perFilePages: number;
  /** Files that get their own reader call before synthesis. */
  fanoutFiles: number;
  /** Total pages handed to the cross-file writer. */
  writerPack: number;
};

/**
 * Retrieval budgets scale with the number of documents in the pile: more
 * files means more pages read and a wider fan-out, bounded by ASK_PACK_CHARS.
 */
export function askBudget(fileCount: number): AskBudget {
  if (fileCount <= 1) return { singlePack: 24, perFilePages: 15, fanoutFiles: 1, writerPack: 24 };
  if (fileCount <= 5)
    return { singlePack: 24, perFilePages: 15, fanoutFiles: fileCount, writerPack: 60 };
  if (fileCount <= 12)
    return { singlePack: 24, perFilePages: 8, fanoutFiles: fileCount, writerPack: 88 };
  if (fileCount <= 30)
    return { singlePack: 24, perFilePages: 7, fanoutFiles: 24, writerPack: 110 };
  return { singlePack: 24, perFilePages: 6, fanoutFiles: 30, writerPack: 128 };
}

/** Deposition workbench — 5 transcripts, per-file covering windows then cross-check. */
export const DEP_MAX_PAGES = 5000;
export const DEP_MAX_FILES = 5;
export const DEP_MAX_BYTES = 200 * 1024 * 1024;
export const ANALYZE_PACK = 32;
/** Covering window — every block/page is analyzed, this many at a time. */
export const ANALYZE_WINDOW = 16;
/** In-flight covering windows across all files. */
export const ANALYZE_WINDOW_CONCURRENCY = 8;
/** Start analysis on a dirty PDF after this many OCR pages land. */
export const DEP_OCR_ANALYZE_AFTER = 10;
