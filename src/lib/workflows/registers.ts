import type { SourceFile } from "./types";
export type RegisterRecord = {
  values: Record<string, string>;
  line: number;
  endLine: number;
  excerpt: string;
};
/** CSV/TSV parser that preserves physical line spans, quoted commas, escaped
 * quotes and multiline cells. Malformed input fails instead of shifting columns. */
export function readRegister(file: SourceFile): RegisterRecord[] {
  const text = file.text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const delimiter = text.split("\n")[0].includes("\t") ? "\t" : ",";
  const parsed: {
    cells: string[];
    line: number;
    endLine: number;
    excerpt: string;
  }[] = [];
  let cells: string[] = [],
    cell = "",
    quoted = false,
    afterQuote = false,
    line = 1,
    startLine = 1,
    startOffset = 0;
  const commit = (end: number) => {
    cells.push(cell);
    if (cells.some((c) => c.trim()))
      parsed.push({
        cells,
        line: startLine,
        endLine: line,
        excerpt: text.slice(startOffset, end),
      });
    cells = [];
    cell = "";
    afterQuote = false;
    startLine = line + 1;
    startOffset = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += char;
        if (char === "\n") line++;
      }
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
      afterQuote = false;
    } else if (char === "\n") {
      commit(i);
      line++;
    } else if (char === '"' && !cell && !afterQuote) quoted = true;
    else if (char === '"' || (afterQuote && char.trim()))
      throw new Error(`${file.name}: invalid CSV quoting at line ${line}.`);
    else if (!afterQuote) cell += char;
  }
  if (quoted) throw new Error(`${file.name}: a quoted CSV cell was not closed.`);
  if (cell || cells.length || afterQuote) commit(text.length);
  if (parsed.length < 2)
    throw new Error(`${file.name}: supply a header and at least one data row as CSV or TSV.`);
  const headers = parsed[0].cells.map((h) => h.trim());
  if (
    headers.some((h) => !h) ||
    new Set(headers.map((h) => h.toLowerCase())).size !== headers.length ||
    headers.some((h) => ["__proto__", "prototype", "constructor"].includes(h.toLowerCase()))
  )
    throw new Error(`${file.name}: column names must be unique and non-empty.`);
  return parsed.slice(1).map((row) => {
    if (row.cells.length !== headers.length)
      throw new Error(
        `${file.name}: line ${row.line} has ${row.cells.length} columns; expected ${headers.length}. Quote values containing commas.`,
      );
    return {
      ...row,
      values: Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), row.cells[i].trim()])),
    };
  });
}
export function moneyCents(value: string): bigint | null {
  const s = value.trim().replace(/^\$\s*/, "");
  if (!/^(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.replaceAll(",", "").split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function formatMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}$${(absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
