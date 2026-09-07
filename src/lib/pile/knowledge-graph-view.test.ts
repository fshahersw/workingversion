import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GRAPH_NODE_HEIGHT,
  filterKnowledgeGraph,
  layoutKnowledgeGraph,
  zoomAt,
} from "./knowledge-graph-view.ts";
import type { DepGraphEdge, DepGraphNode } from "./deposition-analysis.ts";

const nodes: DepGraphNode[] = [
  { id: "p1", label: "Jane Smith", kind: "person" },
  { id: "p2", label: "Robert Jones", kind: "person" },
  { id: "d1", label: "Exhibit 12", kind: "doc" },
  { id: "o1", label: "Acme Corporation", kind: "org" },
];
const edges: DepGraphEdge[] = [
  { from: "p1", to: "d1", label: "identified", cite: "12:4" },
  { from: "p2", to: "d1", label: "reviewed", cite: "18:2" },
  { from: "p1", to: "o1", label: "worked for", cite: "4:8" },
];

test("graph filtering honors kind and degree without hiding the active node", () => {
  const filtered = filterKnowledgeGraph(
    { nodes, edges },
    { kinds: ["person", "doc"], minDegree: 2, query: "jane", activeId: "p1" },
  );
  assert.deepEqual(
    filtered.nodes.map((node) => node.id),
    ["p1", "d1"],
  );
  assert.deepEqual(filtered.edges.map((edge) => edge.label), ["identified"]);
  assert.deepEqual([...filtered.matches], ["p1"]);
});

test("graph layout is stable and separates cards in each kind column", () => {
  const first = layoutKnowledgeGraph(nodes, edges);
  const second = layoutKnowledgeGraph(nodes, edges);
  assert.deepEqual(first, second);
  const people = first.items
    .filter((node) => node.kind === "person")
    .sort((a, b) => a.y - b.y);
  assert.ok(people[1]!.y - people[0]!.y > GRAPH_NODE_HEIGHT);
  assert.ok(first.width >= 680);
  assert.ok(first.height >= 520);
});

test("zoom keeps the graph point under the cursor fixed", () => {
  const before = { x: 20, y: 40, k: 1 };
  const px = 180;
  const py = 120;
  const graphX = (px - before.x) / before.k;
  const graphY = (py - before.y) / before.k;
  const after = zoomAt(before, px, py, 1.25);
  assert.equal(after.x + graphX * after.k, px);
  assert.equal(after.y + graphY * after.k, py);
});
