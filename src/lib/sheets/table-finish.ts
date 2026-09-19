// ============================================================================
// Column fitting for a finished table (pure; no model, no DOM).
//
// Backs the Sheets `finish_table` operation: after a table is built (a
// privilege log, a chronology, a damages schedule) the columns must fit
// their content — an atomic column (dates, Bates numbers, amounts) snug and
// unwrapped, a prose column wide and wrapped, and no single "Additional
// Participants" cell blowing the row up while its neighbours are crushed to
// three characters. Widths come from the cell text lengths (Calibri 11 ≈ 7 px
// per character), bounded per column and in total, so the result is
// deterministic and reviewable.
// ============================================================================

import type { Scalar } from "./query-range";

export type ColumnKind = "atomic" | "short" | "text";

export type ColumnFit = {
  /** 0-based column offset inside the table range */
  column: number;
  kind: ColumnKind;
  widthPx: number;
  /** turn on wrap for the whole column (header included) */
  wrap: boolean;
  /** longest cell, in characters (for the summary) */
  maxChars: number;
};

export type FitOptions = {
  /** leading header rows (default 1) */
  headerRows?: number;
  /** per-column ceiling for prose columns (default 420 px) */
  maxColWidthPx?: number;
  /** floor for any column (default 56 px) */
  minColWidthPx?: number;
  /** ceiling on the sum of widths; prose columns shrink first (default 1600 px) */
  maxTotalWidthPx?: number;
};

export const CHAR_PX = 7;
export const CELL_PAD_PX = 16;
export const DEFAULT_MAX_COL_PX = 420;
export const DEFAULT_MIN_COL_PX = 56;
export const DEFAULT_MAX_TOTAL_PX = 1600;
/** rows sampled for width estimation on very tall tables */
export const SAMPLE_ROWS = 400;
const TEXT_MIN_PX = 180;
const TEXT_SHRINK_FLOOR_PX = 160;

const ATOMIC_RE =
  /^(?:[-+]?\$?\s?[\d,]+(?:\.\d+)?%?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2}, \d{4}|[A-Z]{1,6}[-_ ]?\d{3,12}|[A-Z0-9][A-Z0-9-]{2,23}|yes|no|true|false|n\/a|tbd)$/i;

const display = (v: Scalar): string => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : String(v));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  // ceil: with few samples the width must lean toward the longest cell, not below it
  return s[Math.min(s.length - 1, Math.ceil(p * (s.length - 1)))]!;
};

/** Deterministic row sample: header rows, then evenly spaced body rows up to SAMPLE_ROWS. */
export function sampleRows<T>(rows: readonly T[], headerRows: number): T[] {
  if (rows.length <= SAMPLE_ROWS + headerRows) return [...rows];
  const head = rows.slice(0, headerRows);
  const body = rows.slice(headerRows);
  const step = body.length / SAMPLE_ROWS;
  const out: T[] = [];
  for (let i = 0; i < SAMPLE_ROWS; i++) out.push(body[Math.floor(i * step)]!);
  return [...head, ...out];
}

export function fitTableColumns(values: readonly Scalar[][], opts?: FitOptions): ColumnFit[] {
  const headerRows = Math.max(0, opts?.headerRows ?? 1);
  const maxCol = opts?.maxColWidthPx ?? DEFAULT_MAX_COL_PX;
  const minCol = opts?.minColWidthPx ?? DEFAULT_MIN_COL_PX;
  const maxTotal = opts?.maxTotalWidthPx ?? DEFAULT_MAX_TOTAL_PX;
  const rows = sampleRows(values, headerRows);
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const fits: ColumnFit[] = [];

  for (let c = 0; c < width; c++) {
    const header = rows.slice(0, headerRows).map((r) => display(r[c] ?? null)).filter(Boolean);
    const bodyCells = rows.slice(headerRows).map((r) => display(r[c] ?? null)).filter((t) => t.trim() !== "");
    const headerChars = header.reduce((n, t) => Math.max(n, t.length), 0);
    const lens = bodyCells.map((t) => t.length);
    const maxBody = lens.reduce((n, l) => Math.max(n, l), 0);
    const p90 = percentile(lens, 0.9);
    const atomic = bodyCells.length > 0 && maxBody <= 24 && bodyCells.every((t) => ATOMIC_RE.test(t.trim()));

    let kind: ColumnKind;
    let px: number;
    let wrap: boolean;
    if (atomic) {
      kind = "atomic";
      // header may be longer than the values ("Production Date"): let it wrap rather than widen a date column
      px = clamp(Math.max(maxBody, Math.min(headerChars, maxBody + 6)) * CHAR_PX + CELL_PAD_PX, minCol, 220);
      wrap = headerChars * CHAR_PX + CELL_PAD_PX > px;
    } else if (maxBody > 40) {
      kind = "text";
      px = clamp(p90 * CHAR_PX + CELL_PAD_PX, TEXT_MIN_PX, maxCol);
      wrap = true;
    } else {
      kind = "short";
      px = clamp(Math.max(maxBody, Math.min(headerChars, maxBody + 8), 4) * CHAR_PX + CELL_PAD_PX, Math.max(minCol, 70), 300);
      wrap = maxBody > 28 || headerChars * CHAR_PX + CELL_PAD_PX > px;
    }
    fits.push({ column: c, kind, widthPx: Math.round(px), wrap, maxChars: Math.max(maxBody, headerChars) });
  }

  // Total budget: prose columns give first, proportionally, down to a floor.
  const total = () => fits.reduce((n, f) => n + f.widthPx, 0);
  if (total() > maxTotal) {
    const text = fits.filter((f) => f.kind === "text");
    const fixed = total() - text.reduce((n, f) => n + f.widthPx, 0);
    const room = Math.max(0, maxTotal - fixed);
    const textSum = text.reduce((n, f) => n + f.widthPx, 0);
    for (const f of text) f.widthPx = Math.round(clamp((f.widthPx / Math.max(1, textSum)) * room, TEXT_SHRINK_FLOOR_PX, maxCol));
  }
  return fits;
}

/** One-line receipt for the tool result. */
export function describeFit(fits: readonly ColumnFit[], columnLabel: (offset: number) => string): string {
  const total = fits.reduce((n, f) => n + f.widthPx, 0);
  const parts = fits.map((f) => `${columnLabel(f.column)} ${f.widthPx}px${f.wrap ? " wrap" : ""}`);
  return `finish_table: ${fits.length} column${fits.length === 1 ? "" : "s"} fitted (${parts.join(", ")}); total ${total}px; cells top-aligned.`;
}
