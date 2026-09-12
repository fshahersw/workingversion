import type {
  AnalysisReport,
  EvidenceReference,
  EvidenceRow,
  ExecutionContext,
  SourceFile,
} from "./types";

export type SourceLine = {
  text: string;
  source: string;
  sourceId?: string;
  line: number;
  page: string;
  endLine?: number;
};
export function sourceLines(files: SourceFile[]): SourceLine[] {
  return files.flatMap((f) => {
    let page = "";
    return f.text
      .split(/\r?\n/)
      .map((text, i) => {
        const marker = /^\s*\[?Page\s+(\d+)\]?\s*$/i.exec(text);
        if (marker) page = marker[1];
        return {
          text: text.trim(),
          source: f.name,
          sourceId: f.id,
          line: i + 1,
          page,
        };
      })
      .filter((l) => l.text && !/^\[?Page\s+\d+\]?$/i.test(l.text));
  });
}
export function reference(line: SourceLine): EvidenceReference {
  return {
    sourceId: line.sourceId || "",
    source: line.source,
    line: line.line,
    endLine: line.endLine,
    page: line.page ? Number(line.page) : undefined,
    excerpt: line.text,
  };
}
export function evidence(
  line: SourceLine,
  cells: Record<string, string>,
  status: EvidenceRow["status"] = "Review",
): EvidenceRow {
  return { id: crypto.randomUUID(), cells, ...reference(line), status };
}
export function sourceFiles(ctx: ExecutionContext): SourceFile[] {
  // Prefer the most recent explicit file-producing step, rather than duplicating
  // every ancestor's files or silently substituting unrelated upload sources.
  const upstream = Object.values(ctx.values)
    .reverse()
    .find((v) => v && typeof v === "object" && Array.isArray((v as { files?: unknown }).files)) as
    | { files: SourceFile[] }
    | undefined;
  const files = upstream ? upstream.files : ctx.files;
  if (upstream) return files;
  return [
    ...files,
    ...(ctx.inputs.text.trim()
      ? [
          {
            id: "input-text",
            name: "Pasted text",
            text: ctx.inputs.text,
            size: ctx.inputs.text.length,
          },
        ]
      : []),
  ];
}
export function reportCsv(report: AnalysisReport): string {
  const quote = (v: string) => `"${(/^[\s]*[=+@-]/.test(v) ? "'" : "") + v.replaceAll('"', '""')}"`;
  return [
    [...report.columns, "Source", "Source ID", "Page", "Line", "Evidence", "Status"],
    ...report.rows.map((r) => [
      ...report.columns.map((c) => r.cells[c] || ""),
      r.source,
      r.sourceId || "",
      r.page ? String(r.page) : "",
      String(r.line),
      r.excerpt,
      r.status,
    ]),
  ]
    .map((row) => row.map(quote).join(","))
    .join("\r\n");
}
export function makeReport(
  title: string,
  columns: string[],
  allRows: EvidenceRow[],
  notes: string[],
  extra = "",
  files: SourceFile[] = [],
): AnalysisReport {
  const rows = allRows.slice(0, 1200);
  const warnings = files.flatMap((f) => (f.metadata?.warnings || []).map((w) => `${f.name}: ${w}`));
  if (allRows.length > rows.length)
    warnings.push(
      `Showing ${rows.length} of ${allRows.length} findings. Narrow the source set to review the remainder.`,
    );
  const missing = rows.filter((r) => r.status === "Missing").length;
  const summary = rows.length
    ? `${rows.length} findings for review${missing ? ` · ${missing} missing-information flags` : ""}.`
    : "No matching evidence found in the supplied material. Nothing has been inferred to fill the gaps.";
  const fullNotes = [...notes, ...warnings];
  const text = `${title}\n\n${summary}\n\n${extra}${rows.map((r, i) => `${i + 1}. ${columns.map((c) => `${c}: ${r.cells[c] || "Not found"}`).join(" | ")}\n   Source: ${r.source}${r.page ? `, page ${r.page}` : ""}, ${r.line > 0 ? `extracted line ${r.line}${r.endLine ? `–${r.endLine}` : ""}` : "document-level check"}\n   Evidence: ${r.excerpt || "No matching source excerpt"}${r.references?.map((ref) => `\n   Supporting source: ${ref.source}, line ${ref.line} — ${ref.excerpt}`).join("") || ""}`).join("\n\n")}\n\nReview notes\n${fullNotes.map((n) => `• ${n}`).join("\n")}`;
  return {
    type: "analysis-report",
    title,
    summary,
    columns,
    rows,
    notes: fullNotes,
    text,
    coverage: {
      documents: files.length,
      characters: files.reduce((n, f) => n + f.text.length, 0),
      totalRows: allRows.length,
      shownRows: rows.length,
      warnings,
    },
  };
}
export function matchesTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    !!term.trim() && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text)
  );
}
export function strictDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value.trim()
    ? value.trim()
    : null;
}

/** Validate source anchors from a connected tool before displaying its findings.
 * This verifies provenance only; it cannot establish that a legal inference is correct. */
export function validateReportEvidence(report: AnalysisReport, files: SourceFile[]): string[] {
  const errors: string[] = [];
  for (const row of report.rows) {
    for (const ref of [row, ...(row.references || [])]) {
      if (ref === row && row.status === "Missing" && !row.excerpt) continue;
      const matches = ref.sourceId
        ? files.filter((f) => f.id === ref.sourceId)
        : files.filter((f) => f.name === ref.source);
      if (matches.length !== 1) {
        errors.push(`Finding ${row.id}: source is missing or ambiguous.`);
        continue;
      }
      const lines = matches[0].text.split(/\r?\n/);
      const end = ref.endLine ?? ref.line;
      if (
        !Number.isInteger(ref.line) ||
        !Number.isInteger(end) ||
        ref.line < 1 ||
        end < ref.line ||
        end > lines.length ||
        typeof ref.excerpt !== "string" ||
        !ref.excerpt.trim()
      ) {
        errors.push(`Finding ${row.id}: invalid source range.`);
        continue;
      }
      const normalize = (v: string) => v.replace(/\s+/g, " ").trim();
      if (!normalize(lines.slice(ref.line - 1, end).join("\n")).includes(normalize(ref.excerpt)))
        errors.push(`Finding ${row.id}: quoted evidence does not match the source range.`);
    }
  }
  return errors;
}
