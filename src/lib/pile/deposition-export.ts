import { analysisToMarkdown, EMPTY_ANALYSIS, type DepAnalysis } from "./deposition-analysis.ts";

export const DEPOSITION_EXPORT_SECTIONS = [
  ["summary", "Executive summary"],
  ["profile", "Witness background"],
  ["admissions", "Admissions"],
  ["impeachment", "Impeachment leads"],
  ["themes", "Themes"],
  ["objections", "Objections"],
  ["chronology", "Timeline"],
  ["exhibits", "Exhibits"],
  ["witnesses", "Witnesses"],
  ["contradictions", "Potential conflicts"],
  ["graph", "Mapped relationships"],
] as const;
export type DepExportSection = (typeof DEPOSITION_EXPORT_SECTIONS)[number][0];
export type DepExportRow = {
  section: string;
  title: string;
  summary: string;
  date: string;
  witness: string;
  source: string;
  cite: string;
  quote: string;
  evidence: string;
  tags: string;
};

export function depositionExportRows(a: DepAnalysis, sections: DepExportSection[]): DepExportRow[] {
  const rows: DepExportRow[] = [];
  const blank = {
    section: "",
    title: "",
    summary: "",
    date: "",
    witness: "",
    source: "",
    cite: "",
    quote: "",
    evidence: "needs_review",
    tags: "",
  };
  for (const section of sections) {
    if (section === "summary") {
      if (a.summary)
        rows.push({ ...blank, section, title: "Executive summary", summary: a.summary });
      continue;
    }
    if (section === "contradictions") {
      for (const c of a.contradictions)
        for (const [side, value] of [
          ["A", c.a],
          ["B", c.b],
        ] as const)
          rows.push({
            ...blank,
            section: "Potential conflict",
            title: `${c.title} · ${side}`,
            summary: c.summary,
            witness: value.witness,
            source: value.fileName,
            cite: value.cite,
            quote: value.quote,
            evidence: value.evidenceStatus || "needs_review",
            tags: c.tags.join("; "),
          });
      continue;
    }
    if (section === "graph") {
      const nodes = new Map(a.graph.nodes.map((n) => [n.id, n]));
      for (const e of a.graph.edges)
        rows.push({
          ...blank,
          section: "Mapped relationship",
          title: `${nodes.get(e.from)?.label || e.from} → ${nodes.get(e.to)?.label || e.to}`,
          summary: e.label,
          source: e.fileName || "",
          cite: e.cite,
          quote: e.quote || "",
          evidence: e.evidenceStatus || "needs_review",
        });
      continue;
    }
    for (const item of a[section])
      rows.push({
        ...blank,
        section,
        title: "title" in item ? item.title : "name" in item ? item.name : "",
        summary: item.summary,
        date: "date" in item ? item.date : "",
        witness: section === "witnesses" && "name" in item ? item.name : "",
        source: item.fileName || "",
        cite: item.cite,
        quote: item.quote,
        evidence: item.evidenceStatus || "needs_review",
        tags: "tags" in item ? item.tags.join("; ") : "",
      });
  }
  return rows;
}

/** Neutralize spreadsheet formulas while preserving every evidence field. */
export function exportCsvValue(value: string): string {
  return `"${(/^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`;
}
export function depositionExportCsv(
  a: DepAnalysis,
  sections: DepExportSection[],
  complete = false,
): string {
  const headers: (keyof DepExportRow)[] = [
    "section",
    "title",
    "summary",
    "date",
    "witness",
    "source",
    "cite",
    "quote",
    "evidence",
    "tags",
  ];
  return (
    "\uFEFF" +
    [
      ["analysis_status", ...headers].join(","),
      ...depositionExportRows(a, sections).map((row) =>
        [
          exportCsvValue(
            complete ? "Passes completed; review required" : "PARTIAL ANALYSIS; review required",
          ),
          ...headers.map((key) => exportCsvValue(row[key])),
        ].join(","),
      ),
    ].join("\r\n")
  );
}
export function depositionExportMarkdown(
  a: DepAnalysis,
  sections: DepExportSection[],
  label: string,
  complete: boolean,
): string {
  const selected = structuredClone(EMPTY_ANALYSIS);
  selected.role = a.role;
  for (const section of sections) Object.assign(selected, { [section]: a[section] });
  const status = complete
    ? "Analysis passes completed; findings require source and legal review."
    : "PARTIAL ANALYSIS — one or more passes have not completed. This export contains available findings only.";
  const notice = `Exported ${new Date().toISOString()}\n\n${status}\n\nSource-matched means the quotation was located in a transcript. It does not establish that a legal characterization, admission, or conflict is correct.\n\n`;
  // Include exact paired provenance and graph quotes in a uniform evidence appendix;
  // the memo renderer is optimized for narrative reading and may condense them.
  const evidence = depositionExportRows(a, sections)
    .filter((r) => r.source || r.quote)
    .map(
      (r) =>
        `### ${r.title.replace(/[\r\n]/g, " ")}\n\n${r.source || "Source unresolved"} · ${r.cite || "Page/line unresolved"} · ${r.evidence}\n\n> ${r.quote.replace(/\n/g, "\n> ") || "No matched quotation"}`,
    )
    .join("\n\n");
  return (
    notice +
    analysisToMarkdown(label, selected) +
    (evidence ? `\n\n## Source evidence\n\n${evidence}` : "")
  );
}
