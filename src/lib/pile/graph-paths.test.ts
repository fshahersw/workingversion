import assert from "node:assert/strict";
import { test } from "node:test";

import { enumeratePaths, rankPaths, serialisePath } from "./graph-paths.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";

const edges: ClassifiedGraphEdge[] = [
  { from: "p1", to: "o1", label: "employed by", cite: "Smith 2:15", class: "factual" },
  { from: "o1", to: "d1", label: "received", cite: "Jones 3:4", class: "factual" },
  { from: "p2", to: "d1", label: "signed log for", cite: "2:11", class: "factual" },
];

test("enumeratePaths finds seed-to-seed hops and serialises cited paths", () => {
  const paths = rankPaths(enumeratePaths(edges, ["p1", "p2"], ["d1"]));
  assert.ok(paths.length >= 1);
  const labels: Record<string, string> = {
    p1: "Jane Smith",
    p2: "Robert Jones",
    o1: "Delta",
    d1: "Exhibit 7",
  };
  const serial = serialisePath(paths[0]!, (id) => labels[id] ?? id);
  assert.match(serial, /Jane Smith|Robert Jones/);
  assert.match(serial, /Exhibit 7|Delta/);
});

test("path text preserves original edge direction when traversing backwards", () => {
  const paths = enumeratePaths([edges[0]!], ["o1"], ["p1"]);
  assert.match(
    serialisePath(paths[0]!, (id) => id),
    /o1 ← employed by ← p1/,
  );
  assert.deepEqual(paths[0]!.files, [], "unnamed citations must not count as distinct transcripts");
});

test("dense cyclic graphs have bounded simple paths and respect hop limits", () => {
  const dense: ClassifiedGraphEdge[] = [];
  for (let a = 0; a < 35; a++)
    for (let b = a + 1; b < 35; b++)
      dense.push({ from: `${a}`, to: `${b}`, label: "related", cite: "1:2", class: "factual" });
  const paths = enumeratePaths(dense, ["0"], ["2", "3", "4"], 2);
  assert.ok(paths.length > 0 && paths.length <= 256);
  assert.ok(paths.every((p) => p.edges.length <= 2 && p.nodes.length === new Set(p.nodes).size));
});
