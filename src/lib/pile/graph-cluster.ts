import type { DepGraphNode } from "./deposition-analysis.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";

export type GraphCluster = {
  id: string;
  label: string;
  nodeIds: string[];
  files: string[];
  edges: number;
  conflicts: number;
  corroborations: number;
};

const ITERATIONS = 20;
const NODE_CAP = 400;

function edgeWeight(edge: ClassifiedGraphEdge): number {
  return edge.class === "contradicts" ? 0.5 : 1;
}

const REFINE_PASSES = 10;

/**
 * Local-moving modularity refinement (the first phase of Louvain) on top of
 * the label-propagation seed. Propagation is fast but greedy: a node that
 * touches two communities equally lands wherever the tie broke. Moving each
 * node to the neighbouring community with the best modularity gain fixes those
 * seams deterministically (nodes visited by descending weighted degree, then
 * id; ties on gain keep the current community, then the smaller label).
 */
function refineByModularity(
  ids: string[],
  index: Map<string, number>,
  adj: { to: string; weight: number }[][],
  labels: string[],
): void {
  const strength = ids.map((_, i) => adj[i]!.reduce((sum, edge) => sum + edge.weight, 0));
  const m2 = strength.reduce((sum, k) => sum + k, 0); // 2m
  if (m2 <= 0) return;
  const tot = new Map<string, number>();
  ids.forEach((_, i) => tot.set(labels[i]!, (tot.get(labels[i]!) ?? 0) + strength[i]!));
  const order = ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => strength[b.i]! - strength[a.i]! || a.id.localeCompare(b.id));

  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    let moved = false;
    for (const { i } of order) {
      const own = labels[i]!;
      const ki = strength[i]!;
      if (!adj[i]!.length) continue;
      const toCommunity = new Map<string, number>();
      for (const edge of adj[i]!) {
        const label = labels[index.get(edge.to)!]!;
        toCommunity.set(label, (toCommunity.get(label) ?? 0) + edge.weight);
      }
      // Gain of placing i in community c, with i removed from its own first.
      const gain = (c: string): number => {
        const kIn = toCommunity.get(c) ?? 0;
        const totC = (tot.get(c) ?? 0) - (c === own ? ki : 0);
        return kIn / m2 - (ki * totC) / (m2 * m2 / 2);
      };
      let best = own;
      let bestGain = gain(own);
      for (const c of [...toCommunity.keys()].sort()) {
        if (c === own) continue;
        const g = gain(c);
        if (g > bestGain + 1e-12) {
          best = c;
          bestGain = g;
        }
      }
      if (best !== own) {
        labels[i] = best;
        tot.set(own, (tot.get(own) ?? 0) - ki);
        tot.set(best, (tot.get(best) ?? 0) + ki);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function clusterLabel(nodes: DepGraphNode[], degree: Map<string, number>): string {
  const ranked = [...nodes].sort(
    (a, b) =>
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label),
  );
  const nonPerson = ranked.find((node) => node.kind !== "person");
  if (nonPerson) return nonPerson.label;
  const top = ranked[0];
  if (!top) return "Unclustered";
  const surname = top.label.trim().split(/\s+/).pop() ?? top.label;
  return ranked.length > 1 ? `${surname} et al.` : top.label;
}

export function clusterGraph(
  graph: { nodes: DepGraphNode[]; edges: ClassifiedGraphEdge[] },
  filesOf: (id: string) => string[] = () => [],
): GraphCluster[] {
  const sourceNodes =
    graph.nodes.length > NODE_CAP
      ? graph.nodes.filter((node) => (filesOf(node.id).length >= 2)).concat(
          graph.nodes.filter((node) => filesOf(node.id).length < 2).slice(0, Math.max(0, NODE_CAP - graph.nodes.filter((node) => filesOf(node.id).length >= 2).length)),
        )
      : graph.nodes;
  const ids = sourceNodes.map((node) => node.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const labels = [...ids];
  const adj: { to: string; weight: number }[][] = ids.map(() => []);
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!index.has(edge.from) || !index.has(edge.to) || edge.from === edge.to) continue;
    const weight = edgeWeight(edge);
    adj[index.get(edge.from)!]!.push({ to: edge.to, weight });
    adj[index.get(edge.to)!]!.push({ to: edge.from, weight });
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    let changed = false;
    for (const id of ids) {
      const votes = new Map<string, number>();
      for (const neighbor of adj[index.get(id)!]!) {
        const label = labels[index.get(neighbor.to)!]!;
        votes.set(label, (votes.get(label) ?? 0) + neighbor.weight);
      }
      if (!votes.size) continue;
      let best = labels[index.get(id)!]!;
      let bestWeight = -1;
      for (const [label, weight] of votes) {
        if (weight > bestWeight || (weight === bestWeight && label < best)) {
          best = label;
          bestWeight = weight;
        }
      }
      if (best !== labels[index.get(id)!]) {
        labels[index.get(id)!] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }

  refineByModularity(ids, index, adj, labels);

  const groups = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const label = labels[i]!;
    const list = groups.get(label) ?? [];
    list.push(id);
    groups.set(label, list);
  });

  const byId = new Map(sourceNodes.map((node) => [node.id, node]));
  for (const [label, members] of [...groups.entries()]) {
    if (members.length > 1) continue;
    const id = members[0]!;
    const neighborVotes = new Map<string, number>();
    for (const neighbor of adj[index.get(id)!]!) {
      const other = labels[index.get(neighbor.to)!]!;
      if (other === label) continue;
      neighborVotes.set(other, (neighborVotes.get(other) ?? 0) + neighbor.weight);
    }
    if (!neighborVotes.size) {
      groups.delete(label);
      const unclustered = groups.get("unclustered") ?? [];
      unclustered.push(id);
      groups.set("unclustered", unclustered);
      continue;
    }
    let best = "";
    let bestWeight = -1;
    for (const [other, weight] of neighborVotes) {
      if (weight > bestWeight || (weight === bestWeight && other < best)) {
        best = other;
        bestWeight = weight;
      }
    }
    groups.delete(label);
    const dest = groups.get(best) ?? [];
    dest.push(id);
    groups.set(best, dest);
  }

  const clusters: GraphCluster[] = [];
  for (const [id, nodeIds] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const nodes = nodeIds.map((nodeId) => byId.get(nodeId)!).filter(Boolean);
    const idSet = new Set(nodeIds);
    let edgeCount = 0;
    let conflicts = 0;
    let corroborations = 0;
    for (const edge of graph.edges) {
      if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
      edgeCount += 1;
      if (edge.class === "contradicts") conflicts += 1;
      if (edge.class === "corroborates") corroborations += 1;
    }
    const files = [...new Set(nodeIds.flatMap((nodeId) => filesOf(nodeId)))].sort();
    clusters.push({
      id,
      label: id === "unclustered" ? "Unclustered" : clusterLabel(nodes, degree),
      nodeIds: [...nodeIds].sort(),
      files,
      edges: edgeCount,
      conflicts,
      corroborations,
    });
  }
  return clusters.sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label),
  );
}

export const CLUSTER_PALETTE = [
  "#1e3a5f",
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#be123c",
  "#0369a1",
  "#4d7c0f",
  "#c2410c",
  "#4338ca",
  "#0f766e",
  "#9f1239",
  "#334155",
] as const;
