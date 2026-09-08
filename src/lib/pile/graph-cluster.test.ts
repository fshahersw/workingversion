import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterGraph } from "./graph-cluster.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";
import type { DepGraphNode } from "./deposition-analysis.ts";

const nodes: DepGraphNode[] = [
  { id: "p1", label: "Jane Smith", kind: "person" },
  { id: "p2", label: "Robert Jones", kind: "person" },
  { id: "d1", label: "Safety memo", kind: "doc" },
  { id: "o1", label: "Acme Industrial", kind: "org" },
];

const edges: ClassifiedGraphEdge[] = [
  { from: "p1", to: "d1", label: "identified", cite: "2:20", class: "factual" },
  { from: "p2", to: "o1", label: "employed by", cite: "1:4", class: "factual" },
  { from: "p1", to: "p2", label: "contradicts", cite: "2:11", class: "contradicts" },
];

test("modularity refinement pulls a tie-broken node back to its dense community", () => {
  // Two tight triangles joined by one bridge; the bridge node "x" also touches
  // triangle B once, so propagation can leave it wherever the tie broke.
  const tri = (p: string): DepGraphNode[] =>
    ["1", "2", "3"].map((n) => ({ id: `${p}${n}`, label: `${p}${n}`, kind: "theme" as const }));
  const link = (from: string, to: string): ClassifiedGraphEdge => ({
    from,
    to,
    label: "with",
    cite: "1:1",
    class: "factual",
  });
  const graphNodes = [...tri("a"), ...tri("b"), { id: "x", label: "x", kind: "theme" as const }];
  const graphEdges = [
    link("a1", "a2"),
    link("a2", "a3"),
    link("a1", "a3"),
    link("b1", "b2"),
    link("b2", "b3"),
    link("b1", "b3"),
    link("x", "a1"),
    link("x", "a2"),
    link("x", "b1"),
  ];
  const clusters = clusterGraph({ nodes: graphNodes, edges: graphEdges });
  const ofX = clusters.find((c) => c.nodeIds.includes("x"))!;
  assert.ok(ofX.nodeIds.includes("a1") && ofX.nodeIds.includes("a2"), "x belongs with triangle A");
  assert.ok(!ofX.nodeIds.includes("b1"), "x is not merged into triangle B");
  assert.equal(clusters.length, 2);
});

test("clusterGraph is deterministic and splits unlinked hubs", () => {
  const first = clusterGraph({ nodes, edges });
  const second = clusterGraph({ nodes, edges });
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  const memo = first.find((cluster) => cluster.nodeIds.includes("d1"));
  const acme = first.find((cluster) => cluster.nodeIds.includes("o1"));
  assert.ok(memo);
  assert.ok(acme);
  assert.notEqual(memo!.id, acme!.id);
});
