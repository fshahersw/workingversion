import { ASK_GRAPH_PATH_LEN, ASK_GRAPH_PATHS } from "./limits.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";

export type GraphPath = {
  nodes: string[];
  edges: ClassifiedGraphEdge[];
  files: string[];
  cites: string[];
};

function neighbors(
  id: string,
  edges: ClassifiedGraphEdge[],
): { node: string; edge: ClassifiedGraphEdge }[] {
  const out: { node: string; edge: ClassifiedGraphEdge }[] = [];
  for (const edge of edges) {
    if (edge.from === id) out.push({ node: edge.to, edge });
    else if (edge.to === id) out.push({ node: edge.from, edge });
  }
  return out;
}

export function enumeratePaths(
  edges: ClassifiedGraphEdge[],
  seeds: string[],
  shared: string[] = [],
  maxLen = ASK_GRAPH_PATH_LEN,
): GraphPath[] {
  const seedSet = [...new Set(seeds.filter(Boolean))];
  const sharedSet = new Set(shared);
  const found: GraphPath[] = [];
  const seen = new Set<string>();

  const walk = (start: string, goal: Set<string> | null) => {
    const stack: { node: string; path: string[]; used: ClassifiedGraphEdge[] }[] = [
      { node: start, path: [start], used: [] },
    ];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.path.length > 1) {
        const last = current.path[current.path.length - 1]!;
        const hitGoal = goal ? goal.has(last) && last !== start : current.path.length > 1;
        if (hitGoal) {
          const key = current.path.join(">");
          if (!seen.has(key)) {
            seen.add(key);
            const cites = current.used.map((edge) => edge.cite).filter(Boolean);
            const named = current.used.map((edge) => edge.fileName ?? "").filter(Boolean);
            found.push({
              nodes: current.path,
              edges: current.used,
              // Distinct transcripts when edges carry one; otherwise distinct
              // cites stand in so ranking still prefers better-evidenced paths.
              files: [...new Set(named.length ? named : cites)],
              cites,
            });
          }
        }
      }
      if (current.path.length > maxLen) continue;
      for (const next of neighbors(current.node, edges)) {
        if (current.path.includes(next.node)) continue;
        stack.push({
          node: next.node,
          path: [...current.path, next.node],
          used: [...current.used, next.edge],
        });
      }
    }
  };

  for (let i = 0; i < seedSet.length; i += 1) {
    for (let j = i + 1; j < seedSet.length; j += 1) {
      walk(seedSet[i]!, new Set([seedSet[j]!]));
    }
    if (sharedSet.size) walk(seedSet[i]!, sharedSet);
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
      return index === 0
        ? `${labelOf(path.nodes[0]!)} → ${verb} → ${labelOf(node)}`
        : `→ ${verb} → ${labelOf(node)}`;
    })
    .join(" ");
  const cites = path.cites.filter(Boolean);
  return cites.length ? `${hops} (${cites.join("; ")})` : hops;
}
