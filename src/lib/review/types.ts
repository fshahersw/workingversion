// ============================================================================
// Review Tables — client-safe types.
//
// A review table is a spreadsheet over a working set: rows are documents,
// columns are questions. Every cell carries a cited answer, a status and an
// audit trail. Table state is durable (public.review_* in the app database);
// the documents themselves stay in the browser working set, exactly like the
// Summarize tab, so nothing about the existing pile pipeline changes.
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
export const REVIEW_PIPELINE_VERSION = "nemotron-v2";

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
  fileIds: string[];
  fingerprint: string | null;
  pageCount: number;
  position: number;
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
