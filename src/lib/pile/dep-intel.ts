import type {
  DepAnalysis,
  DepContradiction,
  DepGraphEdge,
  DepGraphNode,
} from "./deposition-analysis.ts";
import { isCorroborationEdge, personNodeMatchesName, nodeFileHints } from "./graph-view.ts";

/**
 * Cross-deposition intelligence. Pure and deterministic: nothing here calls a
 * model, and every number is a count over material the analysis already holds
 * (witness cards, adjudicated contradictions, and the knowledge graph).
 *
 * Attribution uses explicit transcript names and source-matched quotations.
 * Graph proximity and a shared surname never establish who gave testimony.
 */

export type Severity = "high" | "medium" | "low";

export type WitnessCol = { fileName: string; label: string };

export type TranscriptRef = { fileName: string; witness: string | null };

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
  transcripts: TranscriptRef[] = [],
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

export const labelFor =
  (cols: WitnessCol[]) =>
  (fileName: string): string =>
    cols.find((col) => col.fileName === fileName)?.label ?? fileName;

/** Every name the record uses for the witness behind a transcript column. */
function witnessNames(analysis: DepAnalysis, col: WitnessCol): string[] {
  const names = new Set<string>();
  for (const witness of analysis.witnesses) {
    if (witness.fileName === col.fileName && witness.name) names.add(witness.name);
  }
  for (const item of analysis.contradictions) {
    for (const side of [item.a, item.b]) {
      if (side.fileName === col.fileName && side.witness) names.add(side.witness);
    }
  }
  return [...names];
}

/** Person nodes that stand for each transcript's witness. */
export function witnessNodeIds(
  analysis: DepAnalysis,
  cols: WitnessCol[] = witnessColumns(analysis),
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const col of cols) {
    const names = witnessNames(analysis, col);
    const ids = new Set<string>();
    for (const node of analysis.graph.nodes) {
      if (node.kind !== "person") continue;
      if (names.some((name) => personNodeMatchesName(node.label, name))) ids.add(node.id);
    }
    out.set(col.fileName, ids);
  }
  return out;
}

/** Source transcripts attributed to each entity, in column order. */
export function nodeFileMap(
  analysis: DepAnalysis,
  cols: WitnessCol[] = witnessColumns(analysis),
): Map<string, string[]> {
  // Direct source evidence only. A neighbour of a deponent is not automatically
  // evidence that this deponent discussed that entity in their own transcript.
  const order = new Map(cols.map((col, index) => [col.fileName, index]));
  const out = new Map<string, string[]>();
  for (const node of analysis.graph.nodes) {
    const owned = nodeFileHints(node, analysis).sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    out.set(node.id, owned);
  }
  return out;
}

export function conflictSeverity(item: DepContradiction): Severity {
  const omission = item.tags.some((tag) => /omission/i.test(tag));
  const hot = item.tags.some((tag) =>
    /impeach|notice|knowledge|liabilit|causation|damages/i.test(tag),
  );
  if (!omission && hot) return "high";
  if (omission && hot) return "high";
  if (omission) return "low";
  return "medium";
}

export type IntelIssue = {
  id: string;
  title: string;
  detail: string;
  kind: "conflict" | "omission" | "gap";
  severity: Severity;
  files: string[];
  /** Side A's cite (conflicts) or the finding's cite (gaps). */
  cite: string;
  fileName: string;
  /** Side B, when the issue is a contradiction. */
  other?: { cite: string; fileName: string };
};

export function priorityQueue(analysis: DepAnalysis, cap = 40): IntelIssue[] {
  const gaps: IntelIssue[] = [...analysis.admissions, ...analysis.impeachment, ...analysis.themes]
    .filter((item) => item.use === "gap")
    .map((item) => ({
      id: `gap:${item.id}`,
      title: item.title,
      detail: item.summary,
      kind: "gap" as const,
      severity: "medium" as const,
      files: item.fileName ? [item.fileName] : [],
      cite: item.cite,
      fileName: item.fileName ?? "",
    }));
  const conflicts: IntelIssue[] = analysis.contradictions.map((item) => ({
    id: item.id,
    title: item.title,
    detail: item.summary,
    kind: item.tags.some((tag) => /omission/i.test(tag))
      ? ("omission" as const)
      : ("conflict" as const),
    severity: conflictSeverity(item),
    files: [...new Set([item.a.fileName, item.b.fileName].filter(Boolean))],
    cite: item.a.cite,
    fileName: item.a.fileName,
    other: item.b.cite ? { cite: item.b.cite, fileName: item.b.fileName } : undefined,
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

export type SharedEntity = {
  node: DepGraphNode;
  files: string[];
  degree: number;
  conflicted: boolean;
  /** Edges tying the node to each transcript's witness node. */
  mentions: Record<string, number>;
};

function conflictedNodeIds(analysis: DepAnalysis): Set<string> {
  const out = new Set<string>();
  for (const item of analysis.contradictions) {
    for (const node of analysis.graph.nodes) {
      if (node.kind !== "person") continue;
      if (
        personNodeMatchesName(node.label, item.a.witness) ||
        personNodeMatchesName(node.label, item.b.witness)
      ) {
        out.add(node.id);
      }
    }
  }
  return out;
}

export function sharedEntities(
  analysis: DepAnalysis,
  cols: WitnessCol[] = witnessColumns(analysis),
  minFiles = 2,
): SharedEntity[] {
  const degree = new Map<string, number>();
  for (const edge of analysis.graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const owners = witnessNodeIds(analysis, cols);
  const files = nodeFileMap(analysis, cols);
  const conflicted = conflictedNodeIds(analysis);
  return analysis.graph.nodes
    .map((node) => {
      const owned = files.get(node.id) ?? [];
      const mentions: Record<string, number> = {};
      for (const fileName of owned) {
        const ids = owners.get(fileName) ?? new Set<string>();
        if (ids.has(node.id)) {
          mentions[fileName] = degree.get(node.id) ?? 0;
          continue;
        }
        mentions[fileName] = analysis.graph.edges.filter(
          (edge) =>
            (edge.from === node.id && ids.has(edge.to)) ||
            (edge.to === node.id && ids.has(edge.from)),
        ).length;
      }
      return {
        node,
        files: owned,
        degree: degree.get(node.id) ?? 0,
        conflicted: conflicted.has(node.id),
        mentions,
      };
    })
    .filter((row) => row.files.length >= minFiles)
    .sort(
      (a, b) =>
        Number(b.conflicted) - Number(a.conflicted) ||
        b.files.length - a.files.length ||
        b.degree - a.degree ||
        a.node.label.localeCompare(b.node.label),
    );
}

function sideIsFile(
  side: { witness: string; fileName: string },
  fileName: string,
  label: string,
): boolean {
  if (side.fileName) return side.fileName === fileName;
  return !!side.witness && personNodeMatchesName(side.witness, label);
}

export type WitnessProfile = {
  fileName: string;
  label: string;
  /** Graph nodes attributed to this transcript. */
  entities: number;
  /** Of those, nodes another transcript also reaches. */
  shared: number;
  conflicts: number;
  corroborations: number;
  /** Other transcripts tied to this one by shared entities, conflicts, or agreements. */
  connectedTo: string[];
  /** 0–100; the best-connected witness in the set is 100. */
  centrality: number;
};

export function witnessProfiles(
  analysis: DepAnalysis,
  cols: WitnessCol[] = witnessColumns(analysis),
): WitnessProfile[] {
  const files = nodeFileMap(analysis, cols);
  const agreeEdges = analysis.graph.edges.filter((edge) => isCorroborationEdge(edge));
  const raw = cols.map((col) => {
    const connected = new Set<string>();
    let entities = 0;
    let shared = 0;
    for (const node of analysis.graph.nodes) {
      const owned = files.get(node.id) ?? [];
      if (!owned.includes(col.fileName)) continue;
      entities += 1;
      if (owned.length > 1) {
        shared += 1;
        for (const other of owned) if (other !== col.fileName) connected.add(other);
      }
    }
    let conflicts = 0;
    for (const item of analysis.contradictions) {
      const inA = sideIsFile(item.a, col.fileName, col.label);
      const inB = sideIsFile(item.b, col.fileName, col.label);
      if (!inA && !inB) continue;
      conflicts += 1;
      const other = inA ? item.b : item.a;
      if (other.fileName && other.fileName !== col.fileName) connected.add(other.fileName);
    }
    let corroborations = 0;
    for (const edge of agreeEdges) {
      const from = files.get(edge.from) ?? [];
      const to = files.get(edge.to) ?? [];
      if (!from.includes(col.fileName) && !to.includes(col.fileName)) continue;
      corroborations += 1;
      for (const other of [...from, ...to]) if (other !== col.fileName) connected.add(other);
    }
    const connectedTo = [...connected].sort(
      (a, b) => cols.findIndex((c) => c.fileName === a) - cols.findIndex((c) => c.fileName === b),
    );
    const score = shared * 2 + connectedTo.length * 3 + conflicts + corroborations;
    return { ...col, entities, shared, conflicts, corroborations, connectedTo, score };
  });
  const max = Math.max(0, ...raw.map((row) => row.score));
  return raw
    .map(({ score, ...row }) => ({
      ...row,
      centrality: max > 0 ? Math.round((score / max) * 100) : 0,
    }))
    .sort((a, b) => b.centrality - a.centrality || a.label.localeCompare(b.label));
}

export type WitnessComparison = {
  shared: DepGraphNode[];
  onlyA: DepGraphNode[];
  onlyB: DepGraphNode[];
  conflicts: DepContradiction[];
  corroborations: DepGraphEdge[];
};

export function compareWitnesses(
  analysis: DepAnalysis,
  a: string,
  b: string,
  cols: WitnessCol[] = witnessColumns(analysis),
): WitnessComparison {
  const label = labelFor(cols);
  const files = nodeFileMap(analysis, cols);
  const shared: DepGraphNode[] = [];
  const onlyA: DepGraphNode[] = [];
  const onlyB: DepGraphNode[] = [];
  for (const node of analysis.graph.nodes) {
    const owned = files.get(node.id) ?? [];
    const inA = owned.includes(a);
    const inB = owned.includes(b);
    if (inA && inB) shared.push(node);
    else if (inA) onlyA.push(node);
    else if (inB) onlyB.push(node);
  }
  const conflicts = analysis.contradictions.filter((item) => {
    const hasA = sideIsFile(item.a, a, label(a)) || sideIsFile(item.b, a, label(a));
    const hasB = sideIsFile(item.a, b, label(b)) || sideIsFile(item.b, b, label(b));
    return hasA && hasB;
  });
  const corroborations = analysis.graph.edges.filter((edge) => {
    if (!isCorroborationEdge(edge)) return false;
    const from = files.get(edge.from) ?? [];
    const to = files.get(edge.to) ?? [];
    const touchesA = from.includes(a) || to.includes(a);
    const touchesB = from.includes(b) || to.includes(b);
    return touchesA && touchesB;
  });
  return { shared, onlyA, onlyB, conflicts, corroborations };
}

export type IntelSummary = {
  witnesses: number;
  entities: number;
  shared: number;
  conflicts: number;
  high: number;
  corroborations: number;
  edges: number;
};

export function intelSummary(analysis: DepAnalysis, transcripts: TranscriptRef[]): IntelSummary {
  const cols = witnessColumns(analysis, transcripts);
  const shared = sharedEntities(analysis, cols);
  return {
    witnesses: Math.max(cols.length, analysis.witnesses.length),
    entities: analysis.graph.nodes.length,
    shared: shared.length,
    conflicts: analysis.contradictions.length,
    high: analysis.contradictions.filter((item) => conflictSeverity(item) === "high").length,
    corroborations: analysis.graph.edges.filter((edge) => isCorroborationEdge(edge)).length,
    edges: analysis.graph.edges.length,
  };
}
