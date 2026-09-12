import assert from "node:assert/strict";
import { test } from "node:test";

import type { DepAnalysis, DepGraphEdge, DepGraphNode } from "./deposition-analysis.ts";
import { EMPTY_ANALYSIS } from "./deposition-analysis.ts";
import {
  DEFAULT_GRAPH_VIEW,
  conflictEdgesFromAnalysis,
  edgeClassOf,
  hopSet,
  layoutGraph,
  parseGraphView,
  visibleGraph,
  zoomAt,
  personNodeMatchesName,
} from "./graph-view.ts";

const nodes: DepGraphNode[] = [
  { id: "p1", label: "Jane Smith", kind: "person" },
  { id: "p2", label: "Robert Jones", kind: "person" },
  { id: "d1", label: "SB-19-04", kind: "doc" },
  { id: "o1", label: "Acme", kind: "org" },
];
const edges: DepGraphEdge[] = [
  { from: "p1", to: "d1", label: "identified", cite: "2:20-2:21" },
  { from: "p2", to: "d1", label: "reviewed", cite: "2:11" },
  { from: "p1", to: "o1", label: "employed by", cite: "1:4" },
];

const analysis: DepAnalysis = {
  ...EMPTY_ANALYSIS,
  witnesses: [
    {
      id: "w1",
      name: "Jane Smith",
      role: "deponent",
      fileName: "Smith.pdf",
      summary: "",
      quote: "",
      cite: "1:1",
    },
    {
      id: "w2",
      name: "Robert Jones",
      role: "deponent",
      fileName: "Jones.pdf",
      summary: "",
      quote: "",
      cite: "1:1",
    },
  ],
  contradictions: [
    {
      id: "c1",
      title: "Notice date",
      summary: "They disagree on when notice arrived.",
      a: { witness: "Jane Smith", quote: "March", cite: "2:20-2:21", fileName: "Smith.pdf" },
      b: { witness: "Robert Jones", quote: "never", cite: "2:11", fileName: "Jones.pdf" },
      tags: ["notice"],
    },
  ],
  graph: { nodes, edges },
};

test("different people with a shared surname are never merged", () => {
  assert.equal(personNodeMatchesName("Jane Smith", "John Smith"), false);
  assert.equal(personNodeMatchesName("Jane Smith", "Smith"), false);
  assert.equal(personNodeMatchesName("Dr. Jane Smith", "Jane Smith"), true);
});

test("unknown confidence is not treated as 100 percent confidence", () => {
  const graph = visibleGraph(analysis, [], { ...DEFAULT_GRAPH_VIEW, minConfidence: 90 });
  assert.equal(graph.edges.length, 0);
});

test("legacy edges stay in needs-review view and retain their filters", () => {
  assert.equal(
    visibleGraph(analysis, [], { ...DEFAULT_GRAPH_VIEW, evidence: "source_matched" }).edges.length,
    0,
  );
  assert.equal(
    visibleGraph(analysis, [], { ...DEFAULT_GRAPH_VIEW, evidence: "needs_review" }).edges.length,
    3,
  );
  assert.equal(parseGraphView({ evidence: "needs_review" }).evidence, "needs_review");
});

test("zoomAt keeps the graph point under the cursor fixed", () => {
  const before = { x: 20, y: 40, k: 1 };
  const px = 180;
  const py = 120;
  const graphX = (px - before.x) / before.k;
  const graphY = (py - before.y) / before.k;
  const after = zoomAt(before, px, py, 1.25);
  assert.equal(after.x + graphX * after.k, px);
  assert.equal(after.y + graphY * after.k, py);
});

test("visibleGraph hides unchecked kinds and isolated nodes", () => {
  const view = parseGraphView({
    ...DEFAULT_GRAPH_VIEW,
    kinds: { person: true, org: false, doc: true, theme: true, event: true },
    hideIsolated: true,
  });
  const visible = visibleGraph(analysis, [], view);
  assert.deepEqual(visible.nodes.map((node) => node.id).sort(), ["d1", "p1", "p2"]);
  assert.equal(
    visible.nodes.some((node) => node.id === "o1"),
    false,
  );
});

test("visibleGraph can drop factual edges and keep synthetic contradictions", () => {
  const synthetic = conflictEdgesFromAnalysis(analysis);
  assert.ok(synthetic.some((edge) => edge.class === "contradicts"));
  const view = parseGraphView({
    ...DEFAULT_GRAPH_VIEW,
    edges: { factual: false, contradicts: true, corroborates: false },
    hideIsolated: true,
  });
  const visible = visibleGraph(analysis, synthetic, view);
  assert.equal(
    visible.edges.every((edge) => edge.class === "contradicts"),
    true,
  );
  assert.deepEqual(visible.nodes.map((node) => node.id).sort(), ["p1", "p2"]);
});

test("edge labels classify on whole words only", () => {
  const cls = (label: string) => edgeClassOf({ from: "a", to: "b", label, cite: "" });
  assert.equal(cls("identified"), "factual");
  assert.equal(cls("reviewed"), "factual");
  assert.equal(cls("employed by"), "factual");
  assert.equal(cls("denies receiving"), "contradicts");
  assert.equal(cls("contradicts testimony"), "contradicts");
  assert.equal(cls("disagrees with"), "contradicts");
  assert.equal(cls("inconsistent with"), "contradicts");
  assert.equal(cls("agrees with"), "corroborates");
  assert.equal(cls("corroborated by"), "corroborates");
  assert.equal(cls("consistent with"), "corroborates");
});

test("conflict edges carry the contradiction title and source file", () => {
  const [edge] = conflictEdgesFromAnalysis(analysis);
  assert.equal(edge?.class, "contradicts");
  assert.equal(edge?.title, "Notice date");
  assert.equal(edge?.fileName, "Smith.pdf");
  assert.deepEqual([edge?.from, edge?.to].sort(), ["p1", "p2"]);
});

test("cluster layout keeps entity cards from overlapping within and across groups", () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({
    id: `node-${i}`,
    label: `Entity ${i}`,
    kind: "person" as const,
  }));
  const clusters = [
    { id: "a", nodeIds: nodes.slice(0, 4).map((n) => n.id) },
    { id: "b", nodeIds: nodes.slice(4).map((n) => n.id) },
  ];
  const { items } = layoutGraph(nodes, [], "cluster", clusters);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!,
        b = items[j]!;
      assert.ok(
        Math.abs(a.x - b.x) >= 208 || Math.abs(a.y - b.y) >= 82,
        `${a.id} overlaps ${b.id}`,
      );
    }
  }
});

test("every layout places every node inside its canvas and is deterministic", () => {
  const view = parseGraphView(DEFAULT_GRAPH_VIEW);
  const visible = visibleGraph(analysis, conflictEdgesFromAnalysis(analysis), view);
  const clusters = [
    { id: "c-a", nodeIds: ["p1", "d1"] },
    { id: "c-b", nodeIds: ["p2", "o1"] },
  ];
  for (const layout of ["kind", "cluster", "witness", "force"] as const) {
    const first = layoutGraph(visible.nodes, visible.edges, layout, clusters, visible.files);
    const second = layoutGraph(visible.nodes, visible.edges, layout, clusters, visible.files);
    assert.equal(first.items.length, visible.nodes.length, `${layout} drops nodes`);
    assert.deepEqual(first, second, `${layout} is not deterministic`);
    for (const item of first.items) {
      assert.ok(item.x >= 0 && item.x <= first.width, `${layout} x out of bounds for ${item.id}`);
      assert.ok(item.y >= 0 && item.y <= first.height, `${layout} y out of bounds for ${item.id}`);
    }
    const ids = new Set(first.items.map((item) => item.id));
    assert.equal(ids.size, first.items.length, `${layout} duplicates a node`);
  }
});

test("witness layout groups shared entities separately from single-witness nodes", () => {
  const files = new Map<string, string[]>([
    ["p1", ["Smith.pdf"]],
    ["p2", ["Jones.pdf"]],
    ["d1", ["Smith.pdf", "Jones.pdf"]],
    ["o1", ["Smith.pdf"]],
  ]);
  const laid = layoutGraph(nodes, [], "witness", [], files);
  const at = (id: string) => laid.items.find((item) => item.id === id)!;
  // Same-file nodes cluster tightly; the shared exhibit sits in its own group.
  const sameFile = Math.hypot(at("p1").x - at("o1").x, at("p1").y - at("o1").y);
  const sharedToSmith = Math.hypot(at("d1").x - at("p1").x, at("d1").y - at("p1").y);
  assert.ok(sameFile < sharedToSmith);
});

test("hopSet is one hop by default", () => {
  const hops = hopSet("p1", edges, 1);
  assert.deepEqual([...hops!].sort(), ["d1", "o1", "p1"]);
});
