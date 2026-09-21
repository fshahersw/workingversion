// ============================================================================
// Delimited-text (CSV / TSV) parser for the Sheets `import_file` operation.
//
// Pure and deterministic: RFC 4180 quoting (doubled quotes inside quoted
// fields, embedded newlines), CRLF or LF, optional BOM, delimiter sniffing,
// Excel-like value typing that never destroys identifiers:
//  - "" → blank (null)
//  - true/false (any case) → boolean
//  - plain numbers, including "1,200.50", "-3", "4.5e3" → number
//  - anything with a leading zero ("007", "000123") or too long to be a safe
//    integer stays TEXT (Bates numbers, ZIP codes, account ids)
//  - everything else → text, untouched
// Rows are padded with blanks to the widest row so the block is rectangular.
// ============================================================================

import type { Scalar } from "./query-range";

export type Delimiter = "," | ";" | "\t" | "|";

export type ParseOptions = {
  delimiter?: Delimiter | "auto";
  /** stop after this many cells (rows × columns); throws when exceeded */
  maxCells?: number;
  /** keep every value as text (no number/boolean inference) */
  asText?: boolean;
};

export type ParsedTable = {
  rows: Scalar[][];
  delimiter: Delimiter;
  columns: number;
  warnings: string[];
};

export class DelimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelimitedError";
  }
}

export const IMPORT_MAX_CELLS = 200_000;

/** Pick the delimiter that yields the most consistent column count over the first lines. */
export function sniffDelimiter(text: string): Delimiter {
  const sample = text.split(/\r?\n/, 25).filter((l) => l.trim().length);
  const candidates: Delimiter[] = [",", "\t", ";", "|"];
  let best: Delimiter = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map((line) => splitLine(line, d).length);
    if (!counts.length) continue;
    const first = counts[0]!;
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 50) / 50;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Split ONE physical line naively (used only for sniffing). */
function splitLine(line: string, d: Delimiter): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const INT_RE = /^[-+]?\d+$/;
const NUM_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const DEC_RE = /^[-+]?\.\d+$/;

/** Excel-like typing that keeps identifiers as text. */
export function typeCell(raw: string): Scalar {
  const t = raw.trim();
  if (t === "") return null;
  const lower = t.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (INT_RE.test(t)) {
    const digits = t.replace(/^[-+]/, "");
    if (digits.length > 1 && digits.startsWith("0")) return raw; // 007 stays text
    if (digits.length > 15) return raw; // beyond safe integer precision
    return Number(t);
  }
  if (NUM_RE.test(t) || DEC_RE.test(t)) {
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/**
 * Parse delimited text into a rectangular block of typed cells.
 * Throws DelimitedError when the text is empty, unbalanced, or over the cap.
 */
export function parseDelimited(text: string, opts?: ParseOptions): ParsedTable {
  let src = String(text ?? "");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (!src.trim()) throw new DelimitedError("the file is empty");
  const delimiter: Delimiter = !opts?.delimiter || opts.delimiter === "auto" ? sniffDelimiter(src) : opts.delimiter;
  const maxCells = opts?.maxCells ?? IMPORT_MAX_CELLS;
  const warnings: string[] = [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field === "") quoted = true;
      else field += ch; // stray quote mid-field is literal
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) throw new DelimitedError("unbalanced quote — a quoted field never closes");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // drop trailing wholly-empty lines
  while (rows.length && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  if (!rows.length) throw new DelimitedError("the file has no data rows");

  const columns = Math.max(...rows.map((r) => r.length));
  const cells = rows.length * columns;
  if (cells > maxCells)
    throw new DelimitedError(
      `the file has ${rows.length.toLocaleString("en-US")} rows × ${columns} columns = ${cells.toLocaleString("en-US")} cells, above the ${maxCells.toLocaleString("en-US")}-cell import limit — reduce it in Python first (filter rows or drop columns) and write a smaller file.`,
    );
  const ragged = rows.filter((r) => r.length !== columns).length;
  if (ragged) warnings.push(`${ragged} row(s) had fewer fields than the widest row and were padded with blanks.`);

  const typed: Scalar[][] = rows.map((r) => {
    const out: Scalar[] = new Array(columns).fill(null);
    for (let c = 0; c < r.length; c++) out[c] = opts?.asText ? (r[c]!.trim() === "" ? null : r[c]!) : typeCell(r[c]!);
    return out;
  });
  return { rows: typed, delimiter, columns, warnings };
}
