import assert from "node:assert/strict";
import { test } from "node:test";

import { graphQuestion, type GraphAskContext } from "./graph-questions.ts";

const ctx: GraphAskContext = {
  label: "Safety memo",
  kind: "doc",
  witnesses: ["Jane Smith"],
  neighbors: [
    { relation: "identified", other: "Robert Jones" },
    { relation: "contradicts", other: "Acme Industrial", conflict: true },
  ],
  cites: ["12:4", "40:2"],
};

test("every lens names the entity, the witness and asks for page:line cites", () => {
  for (const kind of [
    "testimony",
    "relationships",
    "conflicts",
    "timeline",
    "witnesses",
  ] as const) {
    const q = graphQuestion(kind, ctx);
    assert.match(q, /Safety memo/);
    assert.match(q, /Jane Smith/);
    assert.match(q, /page:line/);
    assert.match(q, /12:4/);
  }
});

test("relationships and conflicts use the graph's own neighbours", () => {
  assert.match(graphQuestion("relationships", ctx), /identified Robert Jones/);
  assert.match(graphQuestion("conflicts", ctx), /Acme Industrial/);
  const noConflict = graphQuestion("conflicts", { ...ctx, neighbors: [] });
  assert.match(noConflict, /internally inconsistent/);
});

test("multi-witness context asks for a comparison; single-witness asks who else", () => {
  const multi = graphQuestion("witnesses", { ...ctx, witnesses: ["Jane Smith", "Robert Jones"] });
  assert.match(multi, /Compare what Jane Smith, Robert Jones each say/);
  assert.match(graphQuestion("witnesses", ctx), /Which other witnesses/);
});

test("long lists are truncated with a count instead of dumping everything", () => {
  const many = graphQuestion("testimony", {
    ...ctx,
    witnesses: ["A", "B", "C", "D", "E"],
    cites: ["1:1", "2:2", "3:3", "4:4", "5:5", "6:6"],
  });
  assert.match(many, /A, B, C and 2 more/);
  assert.match(many, /4:4 and 2 more/);
});
