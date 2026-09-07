import type { DepAnalysis, DepContradiction, DepGraphNode } from "./deposition-analysis.ts";
import { isCorroborationEdge, personNodeMatchesName } from "./graph-view.ts";

export type Severity = "high" | "medium" | "low";

export type WitnessCol = { fileName: string; label: string };

/**
 * Short column handle for a witness: the surname with honorifics and
 * professional suffixes removed. Dots are collapsed first so "M.D." becomes
 * "MD" before the suffix pass; otherwise the last token is "D".
 */
export function witnessHandle(name: string): string {
  const cleaned = name
    .replace(/\.(pdf|docx?|txt|rtf)$/i, "")
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|md|phd|esq|rn|dds|cpa|jd|mba|pe)\b/gi, "")
    .replace(/\bDO\b/g, "")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || name;
}

export function witnessColumns(
  analysis: DepAnalysis,
  transcripts: { fileName: string; witness: string | null }[] = [],
): WitnessCol[] {
  const cols: WitnessCol[] = [];
  const seen = new Set<string>();
  for (const transcript of transcripts) {
    if (!transcript.fileName || seen.has(transcript.fileName)) continue;
    seen.add(transcript.fileName);
    cols.push({
      fileName: transcript.fileName,
      label: witnessHandle(transcript.witness || transcript.fileName),
    });
  }
  for (const witness of analysis.witnesses) {
    if (!witness.fileName || seen.has(witness.fileName)) continue;
    seen.add(witness.fileName);
    cols.push({ fileName: witness.fileName, label: witnessHandle(witness.name) });
  }
  for (const item of analysis.contradictions) {
    for (const side of [item.a, item.b]) {
      if (!side.fileName || seen.has(side.fileName)) continue;
      seen.add(side.fileName);
      cols.push({ fileName: side.fileName, label: witnessHandle(side.witness || side.fileName) });
    }
  }
  return cols;
}

export function conflictSeverity(item: DepContradiction): Severity {
  const omission = item.tags.some((tag) => /omission/i.test(tag));
  const hot = item.tags.some((tag) => /impeach|notice|knowledge|liabilit|causation|damages/i.test(tag));
  if (!omission && hot) return "high";
  if (omission && hot) return "high";
  if (omission) return "low";
  return "medium";
}

export function priorityQueue(analysis: DepAnalysis, cap = 40): Array<{
  id: string;
  title: string;
  detail: string;
  kind: "conflict" | "gap";
  severity: Severity;
  files: string[];
  cite: string;
  fileName: string;
}> {
  const gaps = [...analysis.admissions, ...analysis.impeachment, ...analysis.themes]
    .filter((item) => item.use === "gap")
    .map((item) => ({
      id: `gap:${item.id}`,
      title: item.title,
      detail: item.summary,
      kind: "gap" as const,
      severity: "medium" as const,
      files: [],
      cite: item.cite,
      fileName: "",
    }));
  const conflicts = analysis.contradictions.map((item) => ({
    id: item.id,
    title: item.title,
    detail: item.summary,
    kind: "conflict" as const,
    severity: conflictSeverity(item),
    files: [item.a.fileName, item.b.fileName].filter(Boolean),
    cite: item.a.cite,
    fileName: item.a.fileName,
  }));
  const rank = { high: 0, medium: 1, low: 2 };
  return [...conflicts, ...gaps]
    .sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        b.files.length - a.files.length ||
        a.title.localeCompare(b.title),
    )
    .slice(0, cap);
}

export function sharedEntities(
  analysis: DepAnalysis,
  minFiles = 2,
): Array<{
  node: DepGraphNode;
  files: string[];
  degree: number;
  conflicted: boolean;
}> {
  const degree = new Map<string, number>();
  for (const edge of analysis.graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const conflicted = new Set<string>();
  for (const item of analysis.contradictions) {
    for (const node of analysis.graph.nodes) {
      if (node.kind !== "person") continue;
      if (
        personNodeMatchesName(node.label, item.a.witness) ||
        personNodeMatchesName(node.label, item.b.witness)
      ) {
        conflicted.add(node.id);
      }
    }
  }
  const cols = witnessColumns(analysis);
  return analysis.graph.nodes
    .map((node) => {
      const files =
        node.kind === "person"
          ? cols
              .filter((col) => personNodeMatchesName(node.label, col.label))
              .map((col) => col.fileName)
          : cols.length > 1
            ? cols.map((col) => col.fileName)
            : [];
      const unique = [...new Set(files)];
      return {
        node,
        files: unique,
        degree: degree.get(node.id) ?? 0,
        conflicted: conflicted.has(node.id),
      };
    })
    .filter((row) => row.files.length >= minFiles || (row.node.kind !== "person" && cols.length >= minFiles))
    .sort(
      (a, b) =>
        Number(b.conflicted) - Number(a.conflicted) ||
        b.files.length - a.files.length ||
        b.degree - a.degree ||
        a.node.label.localeCompare(b.node.label),
    );
}

export function compareWitnesses(analysis: DepAnalysis, a: string, b: string) {
  const conflicts = analysis.contradictions.filter((item) => {
    const files = [item.a.fileName, item.b.fileName, item.a.witness, item.b.witness];
    const hasA = files.some((value) => value === a || personNodeMatchesName(value, a));
    const hasB = files.some((value) => value === b || personNodeMatchesName(value, b));
    return hasA && hasB;
  });
  return { conflicts };
}

export function intelSummary(analysis: DepAnalysis, transcripts: { fileName: string; witness: string | null }[]) {
  const cols = witnessColumns(analysis, transcripts);
  const shared = sharedEntities(analysis);
  return {
    witnesses: Math.max(cols.length, analysis.witnesses.length),
    entities: analysis.graph.nodes.length,
    shared: shared.length,
    conflicts: analysis.contradictions.length,
    corroborations: analysis.graph.edges.filter((edge) => isCorroborationEdge(edge)).length,
    edges: analysis.graph.edges.length,
  };
}
