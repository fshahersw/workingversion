// ============================================================================
// Table-cell width policy for rendered research answers (pure).
//
// A markdown table with auto layout gives each column what its content asks
// for. Two failure modes ruin legal tables: an atomic value (a date, a docket
// number, an amount) wrapped vertically down a narrow cell, and one long prose
// cell owning the row while its neighbours shrink to three characters. The
// policy: atomic cells never wrap; prose cells get a floor and a ceiling; the
// table scrolls sideways when the sum exceeds the column.
// ============================================================================

/** Date, number, amount, percentage, docket/Bates number, short code, dash. */
export const ATOMIC_CELL_RE =
  /^\s*(?:[-+]?\$?[\d,]+(?:\.\d+)?%?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2}, \d{4}|\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}(?:-[A-Z]{2,4})?|(?:No\.|MDL|JCCP)\s*\d{2,5}|[A-Z]{1,6}[-_ ]?\d{3,12}|[A-Za-z][A-Za-z0-9.&/-]{0,13}|—|-|n\/a|N\/A)\s*$/;

export type CellKind = "atomic" | "short-header" | "header" | "short" | "prose";

/** Classify a cell's plain text (citation markers already stripped). */
export function classifyCell(text: string, header: boolean): CellKind {
  const t = text.trim();
  if (!t) return header ? "header" : "short";
  const words = t.split(/\s+/).length;
  // short status phrases ("Granted in part", "Under seal") read as one token too
  if (ATOMIC_CELL_RE.test(t) || (words <= 3 && t.length <= 18)) return "atomic";
  if (header) return words <= 3 ? "short-header" : "header";
  return t.length > 60 ? "prose" : "short";
}

/** Tailwind classes per kind. */
export const CELL_CLASS: Record<CellKind, string> = {
  atomic: "whitespace-nowrap tabular-nums",
  "short-header": "whitespace-nowrap",
  header: "min-w-[9rem]",
  short: "min-w-[8rem]",
  prose: "min-w-[14rem] max-w-[34rem]",
};

export function cellClassFor(text: string, header: boolean): string {
  return CELL_CLASS[classifyCell(text, header)];
}
