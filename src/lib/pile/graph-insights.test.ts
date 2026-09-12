import assert from "node:assert/strict";
import { test } from "node:test";
import type { DepGraphNode } from "./deposition-analysis.ts";
import type { ClassifiedGraphEdge } from "./graph-view.ts";
import { mappedGraphInsights, graphEdgeKey } from "./graph-insights.ts";
import { fitGraphNodes } from "./knowledge-graph-view.ts";

const nodes = (ids: string[]): DepGraphNode[] => ids.map((id) => ({ id, label: id, kind: "doc" }));
const edge = (from: string, to: string, fileName = "A.txt"): ClassifiedGraphEdge => ({
  from,
  to,
  label: "reviewed",
  fileName,
  cite: "1:2",
  quote: `A passage linking ${from} and ${to}.`,
  evidenceStatus: "source_matched",
  class: "factual",
});

test("empty graphs produce no invented insights", () => {
  const result = mappedGraphInsights([], []);
  assert.equal(result.insights.length, 0);
  assert.equal(result.sourceMatched, 0);
  assert.equal(result.limited, false);
});

test("shared references count distinct transcripts, not repeated edges or citation numbers", () => {
  const a = edge("memo", "Jane");
  const b = edge("memo", "John", "B.txt");
  const result = mappedGraphInsights(nodes(["memo", "Jane", "John"]), [
    a,
    a,
    { ...a, cite: "4:5" },
    b,
  ]);
  const shared = result.insights.find((i) => i.id === "shared:memo")!;
  assert.deepEqual(shared.files, ["A.txt", "B.txt"]);
  assert.match(shared.explanation, /2 directly connected entities/);
  assert.equal(result.analyzedEdges, 3);
  assert.equal(
    mappedGraphInsights(nodes(["memo", "Jane", "John"]), [
      a,
      { ...b, fileName: "A.txt" },
    ]).insights.some((i) => i.kind === "shared"),
    false,
  );
});

test("missing quotations, missing sources, and unverified links cannot generate structural patterns", () => {
  const rows = [
    edge("a", "b"),
    { ...edge("a", "c", "B.txt"), quote: "" },
    { ...edge("a", "d", "C.txt"), fileName: "" },
    { ...edge("a", "e", "D.txt"), evidenceStatus: "needs_review" as const },
  ];
  const result = mappedGraphInsights(nodes(["a", "b", "c", "d", "e"]), rows);
  assert.equal(result.sourceMatched, 1);
  assert.deepEqual(
    result.insights.map((i) => i.kind),
    ["gap"],
  );
  assert.equal(result.insights[0]!.edges.length, 3);
});

test("bridge detection requires substantial branches and does not mistake a leaf star or cycle for a bridge", () => {
  const ids = nodes(["a", "b", "c", "d", "e"]);
  const chain = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
  assert.deepEqual(
    mappedGraphInsights(ids, chain)
      .insights.filter((i) => i.kind === "bridge")
      .map((i) => i.id),
    ["bridge:c"],
  );
  const cycle = [...chain, edge("a", "e")];
  assert.equal(
    mappedGraphInsights(ids, cycle).insights.some((i) => i.kind === "bridge"),
    false,
  );
  const star = [edge("a", "b"), edge("a", "c"), edge("a", "d"), edge("a", "e")];
  assert.equal(
    mappedGraphInsights(ids, star).insights.some((i) => i.kind === "bridge"),
    false,
  );
  assert.equal(mappedGraphInsights(ids, star).insights.find((i) => i.kind === "hub")?.id, "hub:a");
});

test("unsupported connectors do not join otherwise separate source-linked groups", () => {
  const rows = [
    edge("a", "b"),
    edge("b", "c"),
    edge("d", "e"),
    edge("e", "f"),
    { ...edge("c", "d"), evidenceStatus: "needs_review" as const },
  ];
  const result = mappedGraphInsights(nodes(["a", "b", "c", "d", "e", "f"]), rows);
  assert.deepEqual(
    result.insights.filter((i) => i.kind === "group").map((i) => i.nodeIds),
    [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ],
  );
});

test("potential conflicts require two matched passages and never create shared-witness connections", () => {
  const pair: ClassifiedGraphEdge = {
    ...edge("Jane", "John"),
    class: "contradicts",
    title: "Timing of review",
    pairedEvidence: [
      {
        fileName: "A.txt",
        quote: "I reviewed it in 2019.",
        cite: "1:2",
        evidenceStatus: "source_matched",
      },
      {
        fileName: "B.txt",
        quote: "I reviewed it in 2021.",
        cite: "1:2",
        evidenceStatus: "source_matched",
      },
    ],
  };
  const ids = nodes(["Jane", "John"]);
  const result = mappedGraphInsights(ids, [pair]);
  assert.deepEqual(
    result.insights.map((i) => i.kind),
    ["conflict"],
  );
  assert.deepEqual(result.insights[0]!.files, ["A.txt", "B.txt"]);
  assert.equal(
    mappedGraphInsights(ids, [{ ...pair, pairedEvidence: undefined }]).insights.some(
      (i) => i.kind === "conflict",
    ),
    false,
  );
  const incomplete = {
    ...pair,
    pairedEvidence: [
      pair.pairedEvidence![0]!,
      { ...pair.pairedEvidence![1]!, evidenceStatus: "needs_review" as const },
    ],
  };
  assert.equal(mappedGraphInsights(ids, [incomplete]).insights[0]!.kind, "gap");
  assert.notEqual(
    graphEdgeKey(pair),
    graphEdgeKey({
      ...pair,
      pairedEvidence: [pair.pairedEvidence![0]!, { ...pair.pairedEvidence![1]!, cite: "9:3" }],
    }),
  );
  const same = { ...pair, pairedEvidence: [pair.pairedEvidence![0]!, pair.pairedEvidence![0]!] };
  assert.equal(
    mappedGraphInsights(ids, [same]).insights.some((i) => i.kind === "conflict"),
    false,
  );
});

test("dangling endpoints, self-links, and duplicate links do not inflate counts", () => {
  const a = edge("a", "b");
  const result = mappedGraphInsights(nodes(["a", "b"]), [
    a,
    a,
    edge("a", "missing"),
    edge("a", "a"),
  ]);
  assert.equal(result.analyzedEdges, 1);
  assert.equal(result.insights.length, 0);
});

test("ranked insights are stable under reordered nodes and edges", () => {
  const ids = nodes(["a", "b", "c", "d", "e"]);
  const rows = [edge("a", "b"), edge("b", "c"), edge("c", "d", "B.txt"), edge("d", "e")];
  assert.deepEqual(
    mappedGraphInsights(ids, rows),
    mappedGraphInsights([...ids].reverse(), [...rows].reverse()),
  );
});

test("large-graph analysis is bounded and explicitly discloses partial coverage", () => {
  const ids = nodes(Array.from({ length: 450 }, (_, i) => `n${i}`));
  const rows: ClassifiedGraphEdge[] = [];
  for (let i = 0; i < 100; i++) for (let j = i + 1; j < 100; j++) rows.push(edge(`n${i}`, `n${j}`));
  const result = mappedGraphInsights(ids, rows);
  assert.equal(result.analyzedNodes, 400);
  assert.ok(result.analyzedEdges <= 4000);
  assert.equal(result.totalEdges, 4950);
  assert.equal(result.limited, true);
  assert.ok(result.insights.length <= 24);
});

test("selection framing contains all cards with padding, including negative and distant coordinates", () => {
  for (const viewport of [
    { width: 760, height: 460 },
    { width: 380, height: 260 },
  ]) {
    for (const items of [
      [{ x: 100, y: 100 }],
      [
        { x: -950, y: -900 },
        { x: 6000, y: 4500 },
      ],
    ]) {
      const view = fitGraphNodes(viewport, items)!;
      for (const item of items) {
        assert.ok((item.x - 98) * view.k + view.x >= 40);
        assert.ok((item.x + 98) * view.k + view.x <= viewport.width - 40);
        assert.ok((item.y - 35) * view.k + view.y >= 40);
        assert.ok((item.y + 35) * view.k + view.y <= viewport.height - 40);
      }
      assert.ok(view.k <= 1.15);
    }
  }
  assert.equal(fitGraphNodes({ width: 0, height: 100 }, [{ x: 0, y: 0 }]), null);
  assert.equal(fitGraphNodes({ width: 100, height: 100 }, [{ x: NaN, y: 0 }]), null);
  assert.equal(fitGraphNodes({ width: 100, height: 100 }, []), null);
});
