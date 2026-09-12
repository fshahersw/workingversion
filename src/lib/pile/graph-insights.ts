import type { DepGraphNode } from "./deposition-analysis.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";

export type GraphInsightKind = "conflict" | "shared" | "bridge" | "hub" | "group" | "gap";
export type GraphInsight = {
  id: string;
  kind: GraphInsightKind;
  title: string;
  explanation: string;
  nextStep: string;
  nodeIds: string[];
  edges: ClassifiedGraphEdge[];
  files: string[];
};

/** Identity includes both sides: two different comparisons must never collapse. */
export function graphEdgeKey(edge: ClassifiedGraphEdge): string {
  return JSON.stringify([
    edge.from,
    edge.to,
    edge.label,
    edge.fileName ?? "",
    edge.cite,
    edge.quote ?? "",
    edge.title ?? "",
    edge.pairedEvidence?.map((side) => [side.fileName, side.cite, side.quote]),
  ]);
}

export function hasMatchedGraphEvidence(edge: ClassifiedGraphEdge): boolean {
  if (edge.evidenceStatus !== "source_matched") return false;
  if (edge.pairedEvidence) {
    return (
      edge.pairedEvidence.length === 2 &&
      edge.pairedEvidence.every(
        (side) =>
          side.evidenceStatus === "source_matched" &&
          !!side.fileName?.trim() &&
          !!side.quote?.trim(),
      )
    );
  }
  return !!edge.fileName?.trim() && !!edge.quote?.trim();
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values: string[]) => [...new Set(values)].sort(compare);
const sources = (edges: ClassifiedGraphEdge[]) =>
  unique(
    edges.flatMap((edge) =>
      hasMatchedGraphEvidence(edge)
        ? (edge.pairedEvidence?.map((side) => side.fileName) ?? [edge.fileName!])
        : [],
    ),
  );
const endpoints = (edges: ClassifiedGraphEdge[]) => unique(edges.flatMap((e) => [e.from, e.to]));

/**
 * Structural leads, not factual or legal conclusions. No model call, name inference,
 * confidence score, or assumption that a transcript is an independent witness.
 * Bounds keep analysis responsive for dense imported graphs; coverage is returned.
 */
export function mappedGraphInsights(nodes: DepGraphNode[], input: ClassifiedGraphEdge[]) {
  const allNodes = [...new Map(nodes.map((n) => [n.id, n])).values()].sort((a, b) =>
    compare(a.id, b.id),
  );
  const allIds = new Set(allNodes.map((n) => n.id));
  const valid = [
    ...new Map(
      input
        .filter((e) => e.from !== e.to && allIds.has(e.from) && allIds.has(e.to))
        .map((e) => [graphEdgeKey(e), e]),
    ).values(),
  ].sort((a, b) => compare(graphEdgeKey(a), graphEdgeKey(b)));
  const selectedNodes = allNodes.slice(0, 400);
  const ids = new Set(selectedNodes.map((n) => n.id));
  const edges = valid.filter((e) => ids.has(e.from) && ids.has(e.to)).slice(0, 4000);
  const backed = edges.filter(hasMatchedGraphEvidence);
  // Paired contradictions are comparisons, not testimony connecting two people.
  const structural = backed.filter((e) => !e.pairedEvidence);
  const adjacency = new Map(selectedNodes.map((n) => [n.id, new Set<string>()]));
  const incident = new Map(selectedNodes.map((n) => [n.id, [] as ClassifiedGraphEdge[]]));
  for (const edge of structural) {
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
    incident.get(edge.from)!.push(edge);
    incident.get(edge.to)!.push(edge);
  }
  const byId = new Map(selectedNodes.map((n) => [n.id, n]));
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  for (const node of selectedNodes) {
    if (componentOf.has(node.id) || !adjacency.get(node.id)!.size) continue;
    const queue = [node.id];
    componentOf.set(node.id, components.length);
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]!)!) {
        if (componentOf.has(next)) continue;
        componentOf.set(next, components.length);
        queue.push(next);
      }
    }
    components.push(queue.sort(compare));
  }
  const candidates: (GraphInsight & { rank: number })[] = [];
  const add = (insight: Omit<GraphInsight, "files"> & { rank: number }) =>
    candidates.push({ ...insight, files: sources(insight.edges) });

  for (const edge of backed) {
    if (edge.class !== "contradicts" || !edge.pairedEvidence) continue;
    const [left, right] = edge.pairedEvidence;
    if (left!.fileName === right!.fileName && left!.quote.trim() === right!.quote.trim()) continue;
    add({
      id: `conflict:${graphEdgeKey(edge)}`,
      kind: "conflict",
      rank: 100,
      title: `Potential conflict: ${edge.title || "compare these accounts"}`,
      explanation:
        "The analysis flagged two passages for comparison. Both quotations were located in their source transcripts.",
      nextStep:
        "Compare the question, subject, time period, and scope before treating the accounts as inconsistent.",
      nodeIds: [edge.from, edge.to],
      edges: [edge],
    });
  }

  for (const node of selectedNodes) {
    const related = incident.get(node.id)!;
    const neighbors = adjacency.get(node.id)!;
    const files = sources(related);
    if (files.length >= 2) {
      add({
        id: `shared:${node.id}`,
        kind: "shared",
        rank: 80 + Math.min(8, files.length),
        title: `Shared ${node.kind === "doc" ? "document" : "reference"}: ${node.label}`,
        explanation: `${files.length} transcripts contain source-matched relationships involving this entity and ${neighbors.size} directly connected ${neighbors.size === 1 ? "entity" : "entities"}.`,
        nextStep:
          "Compare what each transcript actually says. A shared reference does not establish agreement or independent corroboration.",
        nodeIds: unique([node.id, ...neighbors]),
        edges: related,
      });
    }

    // Removal test: count substantial branches within this entity's component.
    // Leaf-only stars are hubs, not bridges between groups. O(V × (V + E)), capped above.
    let branches = 0;
    if (neighbors.size >= 2) {
      const visited = new Set([node.id]);
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        const queue = [neighbor];
        visited.add(neighbor);
        for (let i = 0; i < queue.length; i++) {
          for (const next of adjacency.get(queue[i]!)!) {
            if (!visited.has(next)) {
              visited.add(next);
              queue.push(next);
            }
          }
        }
        if (queue.length >= 2) branches++;
      }
    }
    if (branches >= 2) {
      const group = components[componentOf.get(node.id)!]!;
      const groupIds = new Set(group);
      add({
        id: `bridge:${node.id}`,
        kind: "bridge",
        rank: 70 + Math.min(8, branches),
        title: `Connecting entity: ${node.label}`,
        explanation: `Removing this entity separates its source-linked network into ${branches} groups of at least two entities.`,
        nextStep:
          "Trace the connections on each side and inspect their quotations. A connecting path does not establish causation, notice, or responsibility.",
        nodeIds: group,
        edges: structural.filter((e) => groupIds.has(e.from) && groupIds.has(e.to)),
      });
    } else if (neighbors.size >= 3 && files.length < 2) {
      add({
        id: `hub:${node.id}`,
        kind: "hub",
        rank: 50 + Math.min(8, neighbors.size),
        title: `Connection hub: ${node.label}`,
        explanation: `${neighbors.size} distinct entities connect directly to this entity through source-matched relationships. Repeated edges do not inflate this count.`,
        nextStep:
          "Use these relationships to organize follow-up questions and identify documents to review; degree is not a measure of evidentiary importance.",
        nodeIds: unique([node.id, ...neighbors]),
        edges: related,
      });
    }
  }
  if (components.length > 1) {
    for (const group of components.filter((c) => c.length >= 3)) {
      const members = new Set(group);
      const lead = [...group].sort(
        (a, b) => adjacency.get(b)!.size - adjacency.get(a)!.size || compare(a, b),
      )[0]!;
      add({
        id: `group:${group[0]}`,
        kind: "group",
        rank: 40,
        title: `Separate evidence group: ${byId.get(lead)!.label}`,
        explanation: `${group.length} entities form a connected group with no source-matched path to the other groups in this view.`,
        nextStep:
          "Review this group together. Separation may reflect extraction coverage; it does not prove that the subjects are unrelated.",
        nodeIds: group,
        edges: structural.filter((e) => members.has(e.from) && members.has(e.to)),
      });
    }
  }
  const gaps = edges.filter((edge) => !hasMatchedGraphEvidence(edge));
  if (gaps.length)
    add({
      id: "gap:relationships",
      kind: "gap",
      rank: 90,
      title: `${gaps.length} ${gaps.length === 1 ? "relationship needs" : "relationships need"} source review`,
      explanation:
        "These relationships lack a matched quotation and named source, or one side of a comparison has not been matched. They are excluded from structural insights.",
      nextStep:
        "Inspect the relationship, locate the original passage, and verify the extraction before relying on it.",
      nodeIds: endpoints(gaps),
      edges: gaps,
    });
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const isolated = selectedNodes.filter((n) => !linked.has(n.id));
  if (isolated.length)
    add({
      id: "gap:isolated",
      kind: "gap",
      rank: 30,
      title: `${isolated.length} ${isolated.length === 1 ? "entity has" : "entities have"} no mapped relationships`,
      explanation: "These entities were extracted without a relationship in the current view.",
      nextStep:
        "Check active filters and the original testimony. Missing graph links are not evidence that a relationship does not exist.",
      nodeIds: isolated.map((n) => n.id),
      edges: [],
    });
  const perKind = new Map<GraphInsightKind, number>();
  const ordered = candidates.sort((a, b) => b.rank - a.rank || compare(a.id, b.id));
  const insights = ordered
    .filter((item) => {
      const count = perKind.get(item.kind) ?? 0;
      perKind.set(item.kind, count + 1);
      return count < 6;
    })
    .slice(0, 24)
    .map(({ rank: _rank, ...item }) => item);
  return {
    insights,
    totalCandidates: candidates.length,
    sourceMatched: backed.length,
    analyzedEdges: edges.length,
    analyzedNodes: selectedNodes.length,
    totalEdges: valid.length,
    totalNodes: allNodes.length,
    limited: edges.length !== valid.length || selectedNodes.length !== allNodes.length,
  };
}

export type MappedGraphInsights = ReturnType<typeof mappedGraphInsights>;
