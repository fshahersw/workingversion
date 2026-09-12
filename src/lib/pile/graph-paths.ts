import { ASK_GRAPH_PATH_LEN, ASK_GRAPH_PATHS } from "./limits.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";

export type GraphPath = {
  nodes: string[];
  edges: ClassifiedGraphEdge[];
  files: string[];
  cites: string[];
};

/** Bounded breadth-first search: short routes first, no exponential dense-graph walk. */
export function enumeratePaths(
  edges: ClassifiedGraphEdge[],
  seeds: string[],
  shared: string[] = [],
  maxLen = ASK_GRAPH_PATH_LEN,
): GraphPath[] {
  const seedSet = [...new Set(seeds.filter(Boolean))].sort();
  const adjacency = new Map<string, { node: string; edge: ClassifiedGraphEdge }[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    for (const [id, node] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      const list = adjacency.get(id!) ?? [];
      list.push({ node: node!, edge });
      adjacency.set(id!, list);
    }
  }
  for (const list of adjacency.values())
    list.sort(
      (a, b) =>
        a.node.localeCompare(b.node) ||
        (a.edge.fileName ?? "").localeCompare(b.edge.fileName ?? "") ||
        a.edge.cite.localeCompare(b.edge.cite),
    );
  const found: GraphPath[] = [];
  const seen = new Set<string>();
  let budget = 12000;
  const depth = Math.max(1, Math.min(4, Math.floor(maxLen) || ASK_GRAPH_PATH_LEN));
  for (
    let seedIndex = 0;
    seedIndex < seedSet.length && budget > 0 && found.length < 256;
    seedIndex++
  ) {
    const start = seedSet[seedIndex]!;
    const goals = new Set([...seedSet.slice(seedIndex + 1), ...shared]);
    if (!goals.size) continue;
    const queue: { node: string; path: string[]; used: ClassifiedGraphEdge[] }[] = [
      { node: start, path: [start], used: [] },
    ];
    for (let i = 0; i < queue.length && budget > 0 && found.length < 256; i++) {
      const current = queue[i]!;
      if (current.used.length && goals.has(current.node) && current.node !== start) {
        const key = JSON.stringify([
          current.path,
          current.used.map((e) => [e.from, e.to, e.label, e.fileName, e.cite, e.quote]),
        ]);
        if (!seen.has(key)) {
          seen.add(key);
          found.push({
            nodes: current.path,
            edges: current.used,
            files: [
              ...new Set(current.used.map((e) => e.fileName).filter((f): f is string => !!f)),
            ],
            cites: [...new Set(current.used.map((e) => e.cite).filter(Boolean))],
          });
        }
      }
      if (current.used.length >= depth) continue;
      for (const next of adjacency.get(current.node) ?? []) {
        if (--budget <= 0) break;
        if (!current.path.includes(next.node))
          queue.push({
            node: next.node,
            path: [...current.path, next.node],
            used: [...current.used, next.edge],
          });
      }
    }
  }
  return found;
}

export function rankPaths(paths: GraphPath[], cap = ASK_GRAPH_PATHS): GraphPath[] {
  return [...paths]
    .sort((a, b) => {
      const files = b.files.length - a.files.length;
      if (files) return files;
      const cites = b.cites.length - a.cites.length;
      if (cites) return cites;
      return a.nodes.length - b.nodes.length;
    })
    .slice(0, cap);
}

export function serialisePath(path: GraphPath, labelOf: (id: string) => string): string {
  const hops = path.nodes
    .slice(1)
    .map((node, index) => {
      const edge = path.edges[index];
      const verb = edge?.label ?? "related";
      const arrow = edge?.from === path.nodes[index] ? "→" : "←";
      return index === 0
        ? `${labelOf(path.nodes[0]!)} ${arrow} ${verb} ${arrow} ${labelOf(node)}`
        : `${arrow} ${verb} ${arrow} ${labelOf(node)}`;
    })
    .join(" ");
  const cites = path.cites.filter(Boolean);
  return cites.length ? `${hops} (${cites.join("; ")})` : hops;
}
