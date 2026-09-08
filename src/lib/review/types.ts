// ============================================================================
// Tabular Review — client-safe types.
//
// A review table is a spreadsheet over a document set: rows are documents,
// columns are questions. Every cell carries a cited answer, a status and an
// audit trail. Table state lives in DynamoDB under the owner's Cognito
// principal. Documents are saved as KB workspaces (S3 bytes + pages, Aurora
// chunks + embeddings) that the table references through `sources`; each row
// binds to its KB document so a reopened table rehydrates without re-upload.
// ============================================================================

/** Single kill switch. Set to false and the tab disappears; nothing else changes. */
export const REVIEW_TABLES_ENABLED = true;

/**
 * Nemotron pipeline: extract (nemotron-super) → deterministic citation check
 * → independent verify (nemotron-nano). False falls back to the single
 * Claude/Fireworks call in cell.server.ts. Retrieval is unchanged either way —
 * the browser Pile index picks the pages.
 */
export const REVIEW_PIPELINE_ENABLED = true;

/**
 * Goes into every cell's cache key so flipping the pipeline on (or changing
 * its prompts/chains) invalidates cells produced by the previous model.
 */
export const REVIEW_PIPELINE_VERSION = "nemotron-v3";

/** Page images sent for a vision re-read of a flagged cell (scanned pages). */
export const REVIEW_VISION_MAX_PAGES = 3;
export const REVIEW_VISION_MAX_IMAGE_CHARS = 2_500_000;

/** Skip the verify pass. Cheaper and faster; fewer cells get flagged. */
export const REVIEW_SKIP_VERIFY = false;

/**
 * When a cell comes back low-confidence or needs_review, re-read the same
 * pages with Bedrock Sonnet 5. Nano stays on the hot path; Sonnet is the
 * escalation judge, not the default extractor.
 */
export const REVIEW_ESCALATE_LOW_CONFIDENCE = true;

export const REVIEW_MAX_COLUMNS = 40;
/** Above this, a run gets big enough to warn about before starting. */
export const REVIEW_COLUMN_WARN = 20;
/** Documents sampled by the "Test on 10" pre-run check. */
export const REVIEW_SAMPLE_ROWS = 10;
/**
 * Cells requested in parallel. Nemotron is cheap and fast, so the pipeline
 * fans out wider than the Claude path did.
 */
export const REVIEW_CELL_CONCURRENCY = REVIEW_PIPELINE_ENABLED ? 10 : 6;
/**
 * Pages of evidence packed per cell. Recall lives here: the 8-page budget
 * was a Claude cost decision. With Nemotron the constraint is gone, so the
 * pipeline reads twice as much of each document per question.
 */
export const REVIEW_CELL_PAGES = REVIEW_PIPELINE_ENABLED ? 16 : 8;

/** JSON-serializable cell value — crosses the server-fn RPC boundary, so it
 *  must not be `unknown` (the serializer generic rejects that). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ColumnKind =
  | "text"
  | "long_text"
  | "yes_no"
  | "date"
  | "number"
  | "select"
  | "multi_select"
  | "list";

export const COLUMN_KINDS: { value: ColumnKind; label: string; hint: string }[] = [
  { value: "text", label: "Text", hint: "Short answer" },
  { value: "long_text", label: "Long text", hint: "A paragraph" },
  { value: "yes_no", label: "Yes / No / Unclear", hint: "Three-state" },
  { value: "date", label: "Date", hint: "Normalized to YYYY-MM-DD" },
  { value: "number", label: "Number", hint: "Numeric, unit kept" },
  { value: "select", label: "Single select", hint: "One of your options" },
  { value: "multi_select", label: "Multi select", hint: "Any of your options" },
  { value: "list", label: "List", hint: "Several short values" },
];

export type CellStatus = "pending" | "answered" | "not_found" | "needs_review" | "error";
export type CellConfidence = "high" | "medium" | "low";

export type CellCitation = {
  /** Page number inside the row's document. */
  page: number;
  /** Verbatim span the answer rests on. Kept so a cite is readable later. */
  quote: string;
  fileName?: string;
  /**
   * The quote was read from the page image, not located in the text layer
   * (scanned page whose OCR disagreed with the image). Verify against the page.
   */
  fromImage?: boolean;
};

export type CellPageImage = {
  page: number;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Base64 image bytes. */
  data: string;
};

export type ReviewColumn = {
  id: string;
  tableId: string;
  name: string;
  kind: ColumnKind;
  question: string;
  options: string[];
  version: number;
  position: number;
};

export type ReviewRow = {
  id: string;
  tableId: string;
  label: string;
  /** Live browser pile ids for this session (docId once hydrated from a saved source). */
  fileIds: string[];
  fingerprint: string | null;
  pageCount: number;
  position: number;
  /** KB document this row is bound to, once its source workspace finished ingest. */
  docId: string | null;
  /** Saved workspace (DynamoDB item id) that holds `docId`. */
  workspaceItemId: string | null;
};

export type ReviewSourceSurface = "workingset" | "deposition" | "review";

/**
 * A saved KB workspace a table reads documents from. `owned` sources were
 * created by this table from dropped files and are deleted with it; imported
 * Working Sets are referenced only.
 */
export type ReviewSource = {
  workspaceItemId: string;
  kbWorkspaceId: string;
  surface: ReviewSourceSurface;
  name: string;
  owned: boolean;
  attachedAt: string;
};

/**
 * Stable document evidence shared by direct uploads and imported working sets.
 * File ids and extracted character counts are intentionally excluded because
 * they can change when the same document is re-opened or OCR is retried.
 */
export function documentRowFingerprint(name: string, pageCount: number): string {
  return `${name}|${pageCount}`;
}

export type ReviewCell = {
  id: string;
  tableId: string;
  rowId: string;
  columnId: string;
  display: string;
  value: JsonValue;
  status: CellStatus;
  confidence: CellConfidence | null;
  citations: CellCitation[];
  rationale: string | null;
  pagesSearched: number[];
  error: string | null;
  overridden: boolean;
  verifiedAt: string | null;
  cacheKey: string | null;
};

export type ReviewTable = {
  id: string;
  name: string;
  matterId: string | null;
  matterLabel: string | null;
  instructions: string | null;
  createdAt: string;
  updatedAt: string;
  sources: ReviewSource[];
};

/** What the model is asked to return for one cell. */
export type CellAnswer = {
  value: JsonValue;
  display: string;
  status: Exclude<CellStatus, "pending">;
  confidence: CellConfidence;
  citations: CellCitation[];
  rationale: string;
};

export type CellRequest = {
  columnName: string;
  question: string;
  kind: ColumnKind;
  options: string[];
  instructions?: string | null;
  fileName: string;
  pages: { page: number; text: string; ocr?: boolean }[];
  /** When present the cell is re-read from these page images by the vision judge. */
  images?: CellPageImage[];
};

export function columnKindLabel(kind: ColumnKind): string {
  return COLUMN_KINDS.find((k) => k.value === kind)?.label ?? "Text";
}

/**
 * Cache identity for a cell. A cell is recomputed only when its document,
 * its column's prompt/version or the model changes — so re-running a table
 * after a single prompt edit does not pay for the whole grid again.
 */
export function cellCacheKey(input: {
  rowFingerprint: string | null;
  columnId: string;
  columnVersion: number;
  model: string;
}): string {
  return [
    input.rowFingerprint ?? "row",
    input.columnId,
    `v${input.columnVersion}`,
    input.model,
  ].join("|");
}

export function statusLabel(status: CellStatus): string {
  if (status === "answered") return "Answered";
  if (status === "not_found") return "Not found";
  if (status === "needs_review") return "Needs review";
  if (status === "error") return "Error";
  return "Not run";
}

/** Flattens any cell value to a single grid/export string. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
