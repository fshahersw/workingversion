// ============================================================================
// Deterministic tabular query over a block of cells (pure; no model, no DOM).
//
// Backs the Sheets `query_range` operation: the model states WHAT it wants
// (filter, sort, project, distinct, group + aggregate, page) and this module
// computes it exactly, so the agent never reads 20,000 cells into context and
// reasons about them, and never transcribes results by hand. Columns may be
// named by letter ("F") or, when the block has a header row, by header text
// ("Amount"); matching is case-insensitive and trimmed.
//
// Typing rules (Excel-like, documented in the Sheets `query` guide):
//  - eq/neq/in/notIn compare numbers numerically when BOTH sides are numeric
//    (numeric strings count, "$1,200.50" included), otherwise as trimmed,
//    case-insensitive text; blanks equal "".
//  - gt/gte/lt/lte/between compare numbers when both sides are numeric,
//    dates when both sides parse as dates, otherwise text.
//  - Sorting follows the same ladder; blanks always sort last.
//  - sum/avg/min/max use numeric cells only; count counts non-blank cells.
// ============================================================================

export type Scalar = string | number | boolean | null;

export type PredicateOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn"
  | "blank"
  | "notBlank"
  | "matches";

export type QueryPredicate = {
  column: string;
  op: PredicateOp;
  value?: Scalar;
  value2?: Scalar;
  values?: Scalar[];
};

export type QueryOrder = { column: string; direction?: "asc" | "desc" };

export type AggregateFn = "sum" | "count" | "countDistinct" | "avg" | "min" | "max" | "first";

export type QueryAggregate = { column: string; fn: AggregateFn; as?: string };

export type QuerySpec = {
  /** first source row holds column names */
  hasHeader?: boolean;
  where?: { all?: QueryPredicate[]; any?: QueryPredicate[] };
  orderBy?: QueryOrder[];
  /** output columns (letters or header names); default all, in source order */
  select?: string[];
  distinct?: boolean;
  groupBy?: string[];
  aggregates?: QueryAggregate[];
  limit?: number;
  offset?: number;
  /** emit a header row above the results (default true) */
  writeHeader?: boolean;
};

export type QueryInput = {
  /** column letters of the source block, in order (e.g. ["A","B","C"]) */
  columns: string[];
  /** every source row, header row included when hasHeader */
  rows: Scalar[][];
};

export type QueryResult = {
  header: string[] | null;
  rows: Scalar[][];
  /** rows that passed the filter (before group/distinct/limit) */
  matched: number;
  /** rows in the source block (header excluded) */
  total: number;
  /** result rows before offset/limit were applied */
  resultRows: number;
};

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

// --- value typing -----------------------------------------------------------

const NUMERIC_RE = /^[-+]?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/;

/** Number for a numeric cell or numeric-looking text ("1,200", "$3.50", "12%"); null otherwise. */
export function numericValue(v: Scalar): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || !NUMERIC_RE.test(t) || !/\d/.test(t)) return null;
  const pct = t.endsWith("%");
  const n = Number(t.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

const DATE_RE =
  /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2}, \d{4})$/;

/** Epoch millis for a date-looking string; null otherwise (numbers are not dates here). */
export function dateValue(v: Scalar): number | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!DATE_RE.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** Text form used for equality, membership, distinct and group keys. */
export function matchableText(v: Scalar): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const n = numericValue(v);
  if (n !== null) return String(n);
  return String(v).trim().toLowerCase();
}

function isBlank(v: Scalar): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Ordering ladder: numbers, then dates, then text; blanks last. */
export function compareScalars(a: Scalar, b: Scalar): number {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  const an = numericValue(a);
  const bn = numericValue(b);
  if (an !== null && bn !== null) return an - bn;
  const ad = dateValue(a);
  const bd = dateValue(b);
  if (ad !== null && bd !== null) return ad - bd;
  return String(a).trim().localeCompare(String(b).trim(), undefined, { sensitivity: "base", numeric: true });
}

// --- column resolution ------------------------------------------------------

type Resolver = (name: string, where: string) => number;

function makeResolver(columns: string[], header: Scalar[] | null): Resolver {
  const byLetter = new Map(columns.map((c, i) => [c.toUpperCase(), i]));
  const byHeader = new Map<string, number>();
  const dupes = new Set<string>();
  if (header) {
    header.forEach((h, i) => {
      const key = matchableText(h);
      if (!key) return;
      if (byHeader.has(key)) dupes.add(key);
      else byHeader.set(key, i);
    });
  }
  // A header name wins over a same-looking column letter (a column titled
  // "A" is addressed by that title; use another column's letter otherwise).
  return (name, where) => {
    const raw = String(name ?? "").trim();
    if (!raw) throw new QueryError(`${where}: column is empty`);
    const key = matchableText(raw);
    if (dupes.has(key))
      throw new QueryError(`${where}: header "${raw}" appears more than once — refer to the column by letter`);
    const idx = byHeader.get(key);
    if (idx !== undefined) return idx;
    const letter = byLetter.get(raw.toUpperCase());
    if (letter !== undefined) return letter;
    const names = header
      ? header.map((h, i) => `${columns[i]}${h !== null && h !== "" ? ` (${String(h).trim().slice(0, 30)})` : ""}`)
      : columns;
    throw new QueryError(`${where}: unknown column "${raw}". Available: ${names.join(", ")}`);
  };
}

// --- predicates -------------------------------------------------------------

function textOf(v: Scalar): string {
  return v === null || v === undefined ? "" : String(v).trim().toLowerCase();
}

function evalPredicate(cell: Scalar, p: QueryPredicate, regexCache: Map<string, RegExp>): boolean {
  switch (p.op) {
    case "blank":
      return isBlank(cell);
    case "notBlank":
      return !isBlank(cell);
    case "eq":
      return matchableText(cell) === matchableText(p.value ?? null);
    case "neq":
      return matchableText(cell) !== matchableText(p.value ?? null);
    case "in":
    case "notIn": {
      const set = new Set((p.values ?? []).map((v) => matchableText(v)));
      const hit = set.has(matchableText(cell));
      return p.op === "in" ? hit : !hit;
    }
    case "contains":
      return textOf(cell).includes(textOf(p.value ?? null));
    case "notContains":
      return !textOf(cell).includes(textOf(p.value ?? null));
    case "startsWith":
      return textOf(cell).startsWith(textOf(p.value ?? null));
    case "endsWith":
      return textOf(cell).endsWith(textOf(p.value ?? null));
    case "matches": {
      const pattern = String(p.value ?? "");
      let re = regexCache.get(pattern);
      if (!re) {
        try {
          re = new RegExp(pattern, "i");
        } catch {
          throw new QueryError(`matches: invalid regular expression ${JSON.stringify(pattern)}`);
        }
        regexCache.set(pattern, re);
      }
      return re.test(cell === null ? "" : String(cell));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (isBlank(cell)) return false;
      const c = compareScalars(cell, p.value ?? null);
      return p.op === "gt" ? c > 0 : p.op === "gte" ? c >= 0 : p.op === "lt" ? c < 0 : c <= 0;
    }
    case "between": {
      if (isBlank(cell)) return false;
      return compareScalars(cell, p.value ?? null) >= 0 && compareScalars(cell, p.value2 ?? null) <= 0;
    }
    default:
      throw new QueryError(`unknown predicate op ${String((p as { op: unknown }).op)}`);
  }
}

function validatePredicate(p: QueryPredicate, where: string): void {
  const needsValue: PredicateOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "notContains", "startsWith", "endsWith", "matches"];
  if (needsValue.includes(p.op) && p.value === undefined) throw new QueryError(`${where}: ${p.op} needs value`);
  if (p.op === "between" && (p.value === undefined || p.value2 === undefined))
    throw new QueryError(`${where}: between needs value and value2`);
  if ((p.op === "in" || p.op === "notIn") && (!Array.isArray(p.values) || p.values.length === 0))
    throw new QueryError(`${where}: ${p.op} needs a non-empty values list`);
  if (p.op === "matches" && String(p.value).length > 200) throw new QueryError(`${where}: pattern too long`);
}

// --- aggregates -------------------------------------------------------------

function aggregate(fn: AggregateFn, cells: Scalar[]): Scalar {
  switch (fn) {
    case "count":
      return cells.filter((c) => !isBlank(c)).length;
    case "countDistinct":
      return new Set(cells.filter((c) => !isBlank(c)).map(matchableText)).size;
    case "first":
      return cells.find((c) => !isBlank(c)) ?? null;
    default: {
      const nums = cells.map(numericValue).filter((n): n is number => n !== null);
      if (!nums.length) return null;
      if (fn === "sum") return nums.reduce((a, b) => a + b, 0);
      if (fn === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
      if (fn === "min") return Math.min(...nums);
      return Math.max(...nums);
    }
  }
}

// --- main -------------------------------------------------------------------

export const QUERY_MAX_PREDICATES = 20;
export const QUERY_MAX_ORDER_KEYS = 3;
export const QUERY_MAX_GROUP_COLUMNS = 4;
export const QUERY_MAX_AGGREGATES = 8;

export function runQuery(input: QueryInput, spec: QuerySpec): QueryResult {
  const hasHeader = spec.hasHeader !== false;
  const header = hasHeader ? (input.rows[0] ?? []) : null;
  const data = hasHeader ? input.rows.slice(1) : input.rows;
  const width = input.columns.length;
  const resolve = makeResolver(input.columns, header);
  const nameOf = (idx: number): string =>
    header && !isBlank(header[idx] ?? null) ? String(header[idx]).trim() : input.columns[idx]!;

  // filter
  const all = spec.where?.all ?? [];
  const any = spec.where?.any ?? [];
  if (all.length + any.length > QUERY_MAX_PREDICATES)
    throw new QueryError(`where: at most ${QUERY_MAX_PREDICATES} predicates`);
  const allC = all.map((p, i) => {
    validatePredicate(p, `where.all[${i}]`);
    return { p, idx: resolve(p.column, `where.all[${i}]`) };
  });
  const anyC = any.map((p, i) => {
    validatePredicate(p, `where.any[${i}]`);
    return { p, idx: resolve(p.column, `where.any[${i}]`) };
  });
  const regexCache = new Map<string, RegExp>();
  let rows = data.filter((row) => {
    if (row.every((c) => isBlank(c))) return false; // wholly empty rows never match
    for (const { p, idx } of allC) if (!evalPredicate(row[idx] ?? null, p, regexCache)) return false;
    if (anyC.length && !anyC.some(({ p, idx }) => evalPredicate(row[idx] ?? null, p, regexCache))) return false;
    return true;
  });
  const matched = rows.length;

  // group + aggregate, or project
  let outHeader: string[];
  const groupBy = spec.groupBy ?? [];
  const aggs = spec.aggregates ?? [];
  if (groupBy.length || aggs.length) {
    if (groupBy.length > QUERY_MAX_GROUP_COLUMNS)
      throw new QueryError(`groupBy: at most ${QUERY_MAX_GROUP_COLUMNS} columns`);
    if (aggs.length > QUERY_MAX_AGGREGATES) throw new QueryError(`aggregates: at most ${QUERY_MAX_AGGREGATES}`);
    if (!aggs.length) throw new QueryError("groupBy needs at least one aggregate (e.g. count of a column)");
    const gIdx = groupBy.map((c, i) => resolve(c, `groupBy[${i}]`));
    const aIdx = aggs.map((a, i) => {
      if (!["sum", "count", "countDistinct", "avg", "min", "max", "first"].includes(a.fn))
        throw new QueryError(`aggregates[${i}]: unknown fn ${String(a.fn)}`);
      return resolve(a.column, `aggregates[${i}]`);
    });
    const groups = new Map<string, { key: Scalar[]; rows: Scalar[][] }>();
    for (const row of rows) {
      const keyVals = gIdx.map((i) => row[i] ?? null);
      const key = keyVals.map(matchableText).join("\u0000");
      const g = groups.get(key);
      if (g) g.rows.push(row);
      else groups.set(key, { key: keyVals, rows: [row] });
    }
    rows = [...groups.values()].map((g) => [
      ...g.key,
      ...aggs.map((a, i) => aggregate(a.fn, g.rows.map((r) => r[aIdx[i]!] ?? null))),
    ]);
    outHeader = [
      ...gIdx.map(nameOf),
      ...aggs.map((a, i) => (a.as && a.as.trim()) || `${a.fn}(${nameOf(aIdx[i]!)})`),
    ];
    // sorting after grouping refers to output columns by name/position
    if (spec.orderBy?.length) {
      const outCols = outHeader.map((_, i) => input.columns[i] ?? `#${i + 1}`);
      const outResolve = makeResolver(outCols, outHeader);
      rows = sortRows(rows, spec.orderBy, (name, where) => outResolve(name, where));
    }
  } else {
    if (spec.orderBy?.length) rows = sortRows(rows, spec.orderBy, resolve);
    const sel = spec.select?.length ? spec.select.map((c, i) => resolve(c, `select[${i}]`)) : [...Array(width).keys()];
    rows = rows.map((row) => sel.map((i) => row[i] ?? null));
    outHeader = sel.map(nameOf);
    if (spec.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = row.map(matchableText).join("\u0000");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  const resultRows = rows.length;
  const offset = Math.max(0, Math.floor(spec.offset ?? 0));
  const limit = spec.limit === undefined ? undefined : Math.max(0, Math.floor(spec.limit));
  rows = rows.slice(offset, limit === undefined ? undefined : offset + limit);

  return {
    header: spec.writeHeader === false ? null : outHeader,
    rows,
    matched,
    total: data.length,
    resultRows,
  };
}

function sortRows(rows: Scalar[][], orderBy: QueryOrder[], resolve: Resolver): Scalar[][] {
  if (orderBy.length > QUERY_MAX_ORDER_KEYS) throw new QueryError(`orderBy: at most ${QUERY_MAX_ORDER_KEYS} keys`);
  const keys = orderBy.map((o, i) => ({
    idx: resolve(o.column, `orderBy[${i}]`),
    desc: o.direction === "desc",
  }));
  // stable sort: decorate with original index
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      for (const k of keys) {
        const c = compareScalars(a.row[k.idx] ?? null, b.row[k.idx] ?? null);
        if (c !== 0) {
          // blanks stay last in both directions
          const aBlank = isBlank(a.row[k.idx] ?? null);
          const bBlank = isBlank(b.row[k.idx] ?? null);
          if (aBlank || bBlank) return c;
          return k.desc ? -c : c;
        }
      }
      return a.i - b.i;
    })
    .map((x) => x.row);
}
