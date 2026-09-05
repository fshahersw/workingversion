// Strict RFC 4180 CSV reader for ingest bundles. UTF-8, comma delimited,
// double-quote escaping, header row required, no positional guessing.
export type CsvTable = { header: string[]; rows: Record<string, string>[] };

export function parseCsv(text: string): CsvTable {
  const src = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
    } else field += c;
  }
  if (inQuotes) throw new Error("CSV ends inside an unterminated quoted field");
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }

  const header = records.shift();
  if (!header) throw new Error("CSV is empty — a header row is required");
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) throw new Error(`duplicate CSV column "${h}"`);
    seen.add(h);
  }
  const rows = records.map((r, idx) => {
    if (r.length !== header.length) {
      throw new Error(`row ${idx + 2} has ${r.length} fields, header has ${header.length}`);
    }
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
  return { header, rows };
}

/** Drops empty-string values so zod `.optional()` sees `undefined`, not "". */
export function compact(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) if (v !== "") out[k] = v;
  return out;
}
