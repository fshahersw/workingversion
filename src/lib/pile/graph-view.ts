import type { DepAnalysis, DepGraphEdge, DepGraphNode } from "./deposition-analysis.ts";
import { layoutKnowledgeGraph, type LaidGraphNode } from "./knowledge-graph-view.ts";

export { clampScale, fitGraphView, zoomAt } from "./knowledge-graph-view.ts";
export type { GraphView } from "./knowledge-graph-view.ts";

export type GraphEdgeClass = "factual" | "contradicts" | "corroborates";

export type ClassifiedGraphEdge = DepGraphEdge & {
  class: GraphEdgeClass;
  confidence?: number;
  /** Transcript the edge was drawn from, when known (synthetic conflict edges). */
  fileName?: string;
  /** Human title for synthetic edges, e.g. the contradiction headline. */
  title?: string;
};

export type GraphViewSettings = {
  kinds: Record<DepGraphNode["kind"], boolean>;
  files: string[] | null;
  sharedOnly: boolean;
  edges: { factual: boolean; contradicts: boolean; corroborates: boolean };
  hideIsolated: boolean;
  minDegree: number;
  minConfidence: number;
  labels: "auto" | "always" | "never";
  layout: "kind" | "force" | "witness" | "cluster";
  colorBy: "kind" | "witness" | "cluster";
  hops: 1 | 2;
};

/** Fill colours for node kinds; shared by the card border and the minimap. */
export const KIND_HEX: Record<DepGraphNode["kind"], string> = {
  person: "#1e3a5f",
  org: "#c2410c",
  doc: "#64748b",
  theme: "#047857",
  event: "#b45309",
};

/** v2: cluster layout and colouring by default; earlier saved views are discarded. */
export const GRAPH_VIEW_STORAGE_KEY = "dep-graph-view:v2";

export const DEFAULT_GRAPH_VIEW: GraphViewSettings = {
  kinds: { person: true, org: true, doc: true, theme: true, event: true },
  files: null,
  sharedOnly: false,
  edges: { factual: true, contradicts: true, corroborates: true },
  hideIsolated: false,
  minDegree: 0,
  minConfidence: 0,
  labels: "auto",
  layout: "cluster",
  colorBy: "cluster",
  hops: 1,
};

const KIND_KEYS: DepGraphNode["kind"][] = ["person", "org", "doc", "theme", "event"];

/**
 * Edge-label classifiers. Word-anchored on purpose: a bare `den` fragment
 * matched "identified" and a bare `agree` matched "disagree", which silently
 * recoloured factual edges as conflicts or corroborations.
 */
const CONFLICT_LABEL =
  /\b(?:conflicts?|conflicting|contradicts?|contradicted|contradiction|contradictory|omits?|omitted|omission|den(?:y|ies|ied|ial)|disputes?|disputed|inconsistent|disagrees?|disagreed)\b/i;
const CORROBORATION_LABEL =
  /\b(?:corroborates?|corroborated|corroboration|consistent|confirms?|confirmed|agrees?|agreed|supports?|supported)\b/i;

export function isConflictEdge(edge: Pick<DepGraphEdge, "label">): boolean {
  return CONFLICT_LABEL.test(edge.label);
}

export function isCorroborationEdge(edge: Pick<DepGraphEdge, "label">): boolean {
  return !CONFLICT_LABEL.test(edge.label) && CORROBORATION_LABEL.test(edge.label);
}

export function edgeClassOf(edge: DepGraphEdge): GraphEdgeClass {
  if (isConflictEdge(edge)) return "contradicts";
  if (isCorroborationEdge(edge)) return "corroborates";
  return "factual";
}

function canonName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function lastToken(value: string): string {
  const parts = canonName(value).split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function personNodeMatchesName(label: string, name: string): boolean {
  const left = canonName(label);
  const right = canonName(name);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const a = lastToken(left);
  const b = lastToken(right);
  return a.length > 2 && a === b;
}

export function witnessNodesForSide(
  nodes: DepGraphNode[],
  side: { witness: string; fileName?: string },
): DepGraphNode[] {
  return nodes.filter(
    (node) => node.kind === "person" && personNodeMatchesName(node.label, side.witness),
  );
}

export function conflictEdgesFromAnalysis(analysis: DepAnalysis): ClassifiedGraphEdge[] {
  const out: ClassifiedGraphEdge[] = [];
  const seen = new Set<string>();
  for (const item of analysis.contradictions) {
    const left = witnessNodesForSide(analysis.graph.nodes, item.a);
    const right = witnessNodesForSide(analysis.graph.nodes, item.b);
    for (const a of left) {
      for (const b of right) {
        if (a.id === b.id) continue;
        const key = [a.id, b.id].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          from: a.id,
          to: b.id,
          label: "contradicts",
          cite: item.a.cite || item.b.cite,
          class: "contradicts",
          fileName: item.a.fileName || item.b.fileName || undefined,
          title: item.title,
        });
      }
    }
  }
  return out;
}

export function corroborationEdgesFromAnalysis(analysis: DepAnalysis): ClassifiedGraphEdge[] {
  return analysis.graph.edges
    .filter((edge) => isCorroborationEdge(edge))
    .map((edge) => ({ ...edge, class: "corroborates" as const }));
}

export function classifyGraphEdges(
  analysis: DepAnalysis,
  extra: ClassifiedGraphEdge[] = [],
): ClassifiedGraphEdge[] {
  const factual = analysis.graph.edges.map((edge) => ({
    ...edge,
    class: edgeClassOf(edge),
  }));
  return [...factual, ...extra];
}

export function nodeFileHints(node: DepGraphNode, analysis: DepAnalysis): string[] {
  const files = new Set<string>();
  for (const witness of analysis.witnesses) {
    if (personNodeMatchesName(node.label, witness.name) && witness.fileName) {
      files.add(witness.fileName);
    }
  }
  for (const item of analysis.contradictions) {
    if (personNodeMatchesName(node.label, item.a.witness) && item.a.fileName) files.add(item.a.fileName);
    if (personNodeMatchesName(node.label, item.b.witness) && item.b.fileName) files.add(item.b.fileName);
  }
  return [...files];
}

export function parseGraphView(raw: unknown): GraphViewSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GRAPH_VIEW, kinds: { ...DEFAULT_GRAPH_VIEW.kinds }, edges: { ...DEFAULT_GRAPH_VIEW.edges } };
  const value = raw as Partial<GraphViewSettings>;
  const kinds = { ...DEFAULT_GRAPH_VIEW.kinds };
  for (const kind of KIND_KEYS) {
    if (typeof value.kinds?.[kind] === "boolean") kinds[kind] = value.kinds[kind];
  }
  const edges = { ...DEFAULT_GRAPH_VIEW.edges };
  if (typeof value.edges?.factual === "boolean") edges.factual = value.edges.factual;
  if (typeof value.edges?.contradicts === "boolean") edges.contradicts = value.edges.contradicts;
  if (typeof value.edges?.corroborates === "boolean") edges.corroborates = value.edges.corroborates;
  return {
    kinds,
    files: Array.isArray(value.files) ? value.files.filter((item) => typeof item === "string") : null,
    sharedOnly: Boolean(value.sharedOnly),
    edges,
    hideIsolated: Boolean(value.hideIsolated),
    minDegree: Math.max(0, Math.min(5, Number(value.minDegree) || 0)),
    minConfidence: Math.max(0, Math.min(100, Number(value.minConfidence) || 0)),
    labels: value.labels === "always" || value.labels === "never" ? value.labels : "auto",
    layout:
      value.layout === "force" ||
      value.layout === "witness" ||
      value.layout === "cluster" ||
      value.layout === "kind"
        ? value.layout
        : DEFAULT_GRAPH_VIEW.layout,
    colorBy:
      value.colorBy === "witness" || value.colorBy === "cluster" || value.colorBy === "kind"
        ? value.colorBy
        : DEFAULT_GRAPH_VIEW.colorBy,
    hops: value.hops === 2 ? 2 : 1,
  };
}

export function loadGraphView(): GraphViewSettings {
  if (typeof window === "undefined") return parseGraphView(null);
  try {
    const stored = window.localStorage.getItem(GRAPH_VIEW_STORAGE_KEY);
    return parseGraphView(stored ? JSON.parse(stored) : null);
  } catch {
    return parseGraphView(null);
  }
}

export function saveGraphView(view: GraphViewSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GRAPH_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Viewer preferences are optional.
  }
}

export function undirectedDegree(edges: Array<{ from: string; to: string }>): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

export function hopSet(
  origin: string | null,
  edges: Array<{ from: string; to: string }>,
  hops: 1 | 2,
): Set<string> | null {
  if (!origin) return null;
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }
  const seen = new Set<string>([origin]);
  let frontier = [origin];
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adj.get(id) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return seen;
}

export function visibleGraph(
  analysis: DepAnalysis,
  synthetic: ClassifiedGraphEdge[],
  view: GraphViewSettings,
  fileOf: (node: DepGraphNode) => string[] = (node) => nodeFileHints(node, analysis),
): {
  nodes: DepGraphNode[];
  edges: ClassifiedGraphEdge[];
  degree: Map<string, number>;
  files: Map<string, string[]>;
} {
  const files = new Map(analysis.graph.nodes.map((node) => [node.id, fileOf(node)]));
  const allowedKinds = new Set(KIND_KEYS.filter((kind) => view.kinds[kind]));
  const classified = classifyGraphEdges(analysis, synthetic).filter((edge) => {
    if (!view.edges[edge.class]) return false;
    if ((edge.confidence ?? 100) < view.minConfidence) return false;
    return true;
  });

  const kindIds = new Set(
    analysis.graph.nodes.filter((node) => allowedKinds.has(node.kind)).map((node) => node.id),
  );
  const candidate = classified.filter((edge) => kindIds.has(edge.from) && kindIds.has(edge.to));
  const degree = undirectedDegree(candidate);

  let nodes = analysis.graph.nodes.filter((node) => {
    if (!kindIds.has(node.id)) return false;
    const nodeFiles = files.get(node.id) ?? [];
    if (view.files?.length && !nodeFiles.some((file) => view.files!.includes(file))) return false;
    if (view.sharedOnly && nodeFiles.length < 2) return false;
    return true;
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  let edges = candidate.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const visibleDegree = undirectedDegree(edges);

  nodes = nodes.filter((node) => (visibleDegree.get(node.id) ?? 0) >= view.minDegree);
  if (view.hideIsolated) {
    nodes = nodes.filter((node) => (visibleDegree.get(node.id) ?? 0) > 0);
  }
  const kept = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));

  return { nodes, edges, degree: undirectedDegree(edges), files };
}

export function hashNodeIds(ids: string[]): number {
  let hash = 2166136261;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function layoutByCluster(
  nodes: DepGraphNode[],
  edges: ClassifiedGraphEdge[],
  clusters: { id: string; nodeIds: string[] }[],
): { items: LaidGraphNode[]; width: number; height: number } {
  if (!nodes.length) return { items: [], width: 680, height: 520 };
  const rand = mulberry32(hashNodeIds(nodes.map((node) => node.id)));
  const assigned = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.nodeIds) assigned.set(id, cluster.id);
  }
  const groups = new Map<string, DepGraphNode[]>();
  for (const node of nodes) {
    const id = assigned.get(node.id) ?? "unclustered";
    const list = groups.get(id) ?? [];
    list.push(node);
    groups.set(id, list);
  }
  const keys = [...groups.keys()].sort();
  const count = Math.max(1, keys.length);
  const ring = Math.max(220, 90 + count * 42);
  const cx = 80 + ring;
  const cy = 80 + ring;
  const items: LaidGraphNode[] = [];
  keys.forEach((key, index) => {
    const list = groups.get(key) ?? [];
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const gx = cx + Math.cos(angle) * ring;
    const gy = cy + Math.sin(angle) * ring;
    const radius = 28 + list.length * 16;
    list.forEach((node, nodeIndex) => {
      const local = (nodeIndex / Math.max(1, list.length)) * Math.PI * 2 + rand() * 0.2;
      items.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        x: gx + Math.cos(local) * (list.length === 1 ? 0 : radius),
        y: gy + Math.sin(local) * (list.length === 1 ? 0 : radius),
      });
    });
  });
  const xs = items.map((item) => item.x);
  const ys = items.map((item) => item.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const pad = 72;
  for (const item of items) {
    item.x = item.x - minX + pad + 94;
    item.y = item.y - minY + pad + 32;
  }
  const width = Math.max(680, Math.max(...items.map((item) => item.x)) + 140);
  const height = Math.max(520, Math.max(...items.map((item) => item.y)) + 90);
  void edges;
  return { items, width, height };
}

/**
 * Witness layout: one group per source transcript. Nodes that appear in
 * several transcripts sit in a dedicated "shared" group so cross-witness
 * entities are visually central instead of duplicated.
 */
export function layoutByWitness(
  nodes: DepGraphNode[],
  edges: ClassifiedGraphEdge[],
  files: Map<string, string[]>,
): { items: LaidGraphNode[]; width: number; height: number } {
  const groups: { id: string; nodeIds: string[] }[] = [];
  const index = new Map<string, number>();
  for (const node of nodes) {
    const owned = files.get(node.id) ?? [];
    const key = owned.length > 1 ? "shared" : owned[0] ?? "unassigned";
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ id: key, nodeIds: [] });
    }
    groups[index.get(key)!]!.nodeIds.push(node.id);
  }
  groups.sort((a, b) => {
    if (a.id === "shared") return -1;
    if (b.id === "shared") return 1;
    return a.id.localeCompare(b.id);
  });
  return layoutByCluster(nodes, edges, groups);
}

const FORCE_NODE_CAP = 220;
const FORCE_ITERATIONS = 48;

/**
 * Deterministic force layout (seeded by node ids). Repulsion is O(n^2) so the
 * simulation only runs over the first FORCE_NODE_CAP nodes by degree; the rest
 * keep their seeded positions. Same input always yields the same picture.
 */
export function layoutByForce(
  nodes: DepGraphNode[],
  edges: ClassifiedGraphEdge[],
): { items: LaidGraphNode[]; width: number; height: number } {
  if (!nodes.length) return { items: [], width: 680, height: 520 };
  const width = Math.max(900, Math.round(Math.sqrt(nodes.length) * 230));
  const height = Math.max(620, Math.round(Math.sqrt(nodes.length) * 170));
  const rand = mulberry32(hashNodeIds(nodes.map((node) => node.id)));
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const positions = new Map(
    ordered.map((node) => [
      node.id,
      { x: 100 + rand() * (width - 200), y: 70 + rand() * (height - 140) },
    ]),
  );
  const degree = undirectedDegree(edges);
  const working = [...ordered]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, FORCE_NODE_CAP);
  const workingIds = new Set(working.map((node) => node.id));
  const links = edges.filter(
    (edge) => edge.from !== edge.to && workingIds.has(edge.from) && workingIds.has(edge.to),
  );
  for (let iteration = 0; iteration < FORCE_ITERATIONS; iteration += 1) {
    const delta = new Map(working.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let a = 0; a < working.length; a += 1) {
      const pa = positions.get(working[a]!.id)!;
      const da = delta.get(working[a]!.id)!;
      for (let b = a + 1; b < working.length; b += 1) {
        const pb = positions.get(working[b]!.id)!;
        const db = delta.get(working[b]!.id)!;
        const dx = pa.x - pb.x || 0.01;
        const dy = pa.y - pb.y || 0.01;
        const distance2 = Math.max(400, dx * dx + dy * dy);
        const force = 1_400 / distance2;
        da.x += dx * force;
        da.y += dy * force;
        db.x -= dx * force;
        db.y -= dy * force;
      }
    }
    for (const edge of links) {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 210) * 0.008;
      const df = delta.get(edge.from)!;
      const dt = delta.get(edge.to)!;
      df.x += (dx / distance) * force;
      df.y += (dy / distance) * force;
      dt.x -= (dx / distance) * force;
      dt.y -= (dy / distance) * force;
    }
    for (const node of working) {
      const point = positions.get(node.id)!;
      const move = delta.get(node.id)!;
      point.x = Math.min(width - 100, Math.max(100, point.x + move.x));
      point.y = Math.min(height - 70, Math.max(70, point.y + move.y));
    }
  }
  return {
    width,
    height,
    items: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      ...positions.get(node.id)!,
    })),
  };
}

export function layoutGraph(
  nodes: DepGraphNode[],
  edges: ClassifiedGraphEdge[],
  layout: GraphViewSettings["layout"],
  clusters: { id: string; nodeIds: string[] }[],
  files: Map<string, string[]> = new Map(),
): { items: LaidGraphNode[]; width: number; height: number } {
  if (layout === "cluster") return layoutByCluster(nodes, edges, clusters);
  if (layout === "witness") return layoutByWitness(nodes, edges, files);
  if (layout === "force") return layoutByForce(nodes, edges);
  return layoutKnowledgeGraph(nodes, edges);
}

export function shouldShowNodeLabel(
  scale: number,
  degree: number,
  selected: boolean,
  shared: boolean,
  labels: GraphViewSettings["labels"],
): boolean {
  if (labels === "always" || selected) return true;
  if (labels === "never") return false;
  if (scale < 0.4) return shared || selected;
  if (scale < 0.6) return degree >= 2 || selected;
  return true;
}

export function shouldShowEdgeLabel(
  scale: number,
  labels: GraphViewSettings["labels"],
  focused: boolean,
): boolean {
  if (labels === "never") return false;
  if (labels === "always" || focused) return true;
  return scale >= 0.6;
}
