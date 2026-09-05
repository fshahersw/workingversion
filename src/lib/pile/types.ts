export const PILE_TTL_MS = 4 * 60 * 60 * 1000;

export type PileFile = {
  id: string;
  name: string;
  pageCount: number;
  emptyPages: number;
  ocrPages: number;
};

export type PilePage = {
  fileId: string;
  fileName: string;
  page: number;
  text: string;
  ocr: boolean;
  embedding?: number[];
};

export type PileStructure = {
  inventory: { file: string; docType: string; pages: number }[];
  parties: string[];
  dates: string[];
  issues: string[];
};

export type PileSession = {
  id: string;
  createdAt: number;
  expiresAt: number;
  matterLabel: string | null;
  instructions: string | null;
  files: PileFile[];
  pageCount: number;
  structure: PileStructure | null;
};

export type PileHit = {
  fileId: string;
  fileName: string;
  page: number;
  score: number;
  snippet: string;
  garbled?: boolean;
  ocr?: boolean;
  cite?: string;
  startLine?: number;
  endLine?: number;
};

/** One file's own search result — every file reports, even with zero matches. */
export type PileFileHits = {
  fileId: string;
  fileName: string;
  pageCount: number;
  matched: boolean;
  /** Best raw BM25 score inside this file, for cross-file ordering. */
  topScore: number;
  hits: PileHit[];
};

/** One file's retrieval pack for the per-file reader stage. */
export type PileFilePack = PileFileHits & { pages: PilePage[] };
