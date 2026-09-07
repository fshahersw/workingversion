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
