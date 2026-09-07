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
