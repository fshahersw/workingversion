import type { DepGraphEdge, DepGraphNode } from "./deposition-analysis.ts";

export const GRAPH_KIND_ORDER: DepGraphNode["kind"][] = ["person", "org", "doc", "theme", "event"];
export const GRAPH_NODE_WIDTH = 188;
export const GRAPH_NODE_HEIGHT = 64;

export type GraphView = { x: number; y: number; k: number };
export type LaidGraphNode = Pick<DepGraphNode, "id" | "label" | "kind"> & {
  x: number;
  y: number;
};

export type KnowledgeGraphFilter = {
  kinds: readonly DepGraphNode["kind"][] | null;
  minDegree: number;
  query: string;
  activeId?: string | null;
};

export function clampScale(value: number): number {
  return Math.min(4, Math.max(0.25, value));
}

export function zoomAt(view: GraphView, px: number, py: number, factor: number): GraphView {
  const k = clampScale(view.k * factor);
  const ratio = k / view.k;
  return {
    k,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
  };
}

export function fitGraphView(
  viewport: { width: number; height: number },
  content: { width: number; height: number },
  padding = 28,
): GraphView {
  if (!viewport.width || !viewport.height || !content.width || !content.height) {
    return { x: 0, y: 0, k: 1 };
  }
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const k = clampScale(Math.min(availableWidth / content.width, availableHeight / content.height));
  return {
    k,
    x: (viewport.width - content.width * k) / 2,
    y: (viewport.height - content.height * k) / 2,
  };
}

/** Frame actual card bounds, including negative coordinates and very large groups. */
export function fitGraphNodes(
  viewport: { width: number; height: number },
  nodes: readonly { x: number; y: number }[],
  padding = 44,
): GraphView | null {
  const finite = nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (
    !finite.length ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return null;
  // Cards vary by degree: at most 196 × 70. Extra room also covers focus rings.
  const left = Math.min(...finite.map((n) => n.x)) - 104;
  const right = Math.max(...finite.map((n) => n.x)) + 104;
  const top = Math.min(...finite.map((n) => n.y)) - 42;
  const bottom = Math.max(...finite.map((n) => n.y)) + 42;
  const inset = Math.max(0, Math.min(padding, viewport.width / 4, viewport.height / 4));
  // A fixed minimum zoom would clip large selections. Fit must always fit.
  const k = Math.min(
    1.15,
    (viewport.width - inset * 2) / (right - left),
    (viewport.height - inset * 2) / (bottom - top),
  );
  return {
    k,
    x: viewport.width / 2 - ((left + right) * k) / 2,
    y: viewport.height / 2 - ((top + bottom) * k) / 2,
  };
}

export function filterKnowledgeGraph(
  graph: { nodes: DepGraphNode[]; edges: DepGraphEdge[] },
  filter: KnowledgeGraphFilter,
): {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  degree: Map<string, number>;
  matches: Set<string>;
} {
  const kinds = filter.kinds ? new Set(filter.kinds) : null;
  const kindIds = new Set(
    graph.nodes.filter((node) => !kinds || kinds.has(node.kind)).map((node) => node.id),
  );
  const candidateEdges = graph.edges.filter(
    (edge) => kindIds.has(edge.from) && kindIds.has(edge.to),
  );
  const degree = new Map<string, number>();
  for (const edge of candidateEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const visibleIds = new Set(
    graph.nodes
      .filter(
        (node) =>
          kindIds.has(node.id) &&
          ((degree.get(node.id) ?? 0) >= filter.minDegree || node.id === filter.activeId),
      )
      .map((node) => node.id),
  );
  const nodes = graph.nodes.filter((node) => visibleIds.has(node.id));
  const edges = candidateEdges.filter(
    (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const needle = filter.query.trim().toLocaleLowerCase();
  const matches = new Set(
    needle
      ? nodes
          .filter((node) => node.label.toLocaleLowerCase().includes(needle))
          .map((node) => node.id)
      : nodes.map((node) => node.id),
  );
  return { nodes, edges, degree, matches };
}

export function layoutKnowledgeGraph(
  nodes: DepGraphNode[],
  edges: DepGraphEdge[],
): { items: LaidGraphNode[]; width: number; height: number } {
  const columns: Record<DepGraphNode["kind"], DepGraphNode[]> = {
    person: [],
    org: [],
    doc: [],
    theme: [],
    event: [],
  };
  for (const node of nodes) columns[node.kind].push(node);

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  for (const kind of GRAPH_KIND_ORDER) {
    columns[kind].sort(
      (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label),
    );
  }

  const used = GRAPH_KIND_ORDER.filter((kind) => columns[kind].length > 0);
  const maxRows = Math.max(1, ...used.map((kind) => columns[kind].length));
  const columnWidth = 246;
  const rowHeight = 94;
  const paddingX = 54;
  const paddingY = 54;
  const width = Math.max(680, paddingX * 2 + Math.max(1, used.length) * columnWidth);
  const height = Math.max(520, paddingY * 2 + maxRows * rowHeight);
  const items: LaidGraphNode[] = [];

  used.forEach((kind, column) => {
    const list = columns[kind];
    const spread =
      list.length > 1 ? (height - paddingY * 2 - GRAPH_NODE_HEIGHT) / (list.length - 1) : 0;
    list.forEach((node, row) => {
      items.push({
        id: node.id,
        label: node.label,
        kind,
        x: paddingX + column * columnWidth + GRAPH_NODE_WIDTH / 2,
        y:
          paddingY +
          GRAPH_NODE_HEIGHT / 2 +
          (list.length > 1 ? spread * row : (height - paddingY * 2 - GRAPH_NODE_HEIGHT) / 2),
      });
    });
  });

  return { items, width, height };
}

export function wrapGraphLabel(label: string, max = 21): string[] {
  const words = label.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  let usedWords = 0;
  for (const raw of words) {
    const word = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
      if (lines.length === 2) break;
    } else {
      current = next;
    }
    usedWords += 1;
  }
  if (current && lines.length < 2) lines.push(current);
  if (usedWords < words.length && lines[1] && !lines[1].endsWith("…")) {
    lines[1] = `${lines[1].slice(0, max - 1).trimEnd()}…`;
  }
  return lines.length ? lines : [label.slice(0, max)];
}
