// Canonical document format for KB ingest. Every uploaded file (BDA for
// PDF/image/DOCX, SheetJS for XLSX, direct parse for TXT) converts to this one
// shape, so chunking / embedding / retrieval never branch on the source type.
// Client-safe: pure types, no server imports.

export type BlockKind = "heading" | "para" | "list" | "table" | "figure";

/** A structured table, kept first-class (never flattened to prose until pack). */
export type TableData = {
  header: string[];
  rows: string[][];
  caption?: string;
};

export type Block = {
  kind: BlockKind;
  /** Verbatim text (NEVER summarized — needed for quote verification). For a
   *  table this is a plain-text rendering; `table` holds the structured form. */
  text: string;
  /** Heading depth (kind === "heading"). */
  level?: number;
  table?: TableData;
  /** Extraction confidence 0..1 (e.g. BDA per-page confidence). */
  conf?: number;
};

export type PageSource = "text" | "ocr" | "bda" | "vl" | "sheet";

export type Page = {
  /** 1-indexed; the citation anchor for the whole app (fileId:page). */
  pageNo: number;
  blocks: Block[];
  source?: PageSource;
};

export type CanonicalDoc = {
  docId?: string;
  sha256?: string;
  fileName: string;
  mime?: string;
  pageCount: number;
  pages: Page[];
};
