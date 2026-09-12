import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_ANALYSIS, type DepAnalysis } from "./deposition-analysis.ts";
import {
  compareWitnesses,
  conflictSeverity,
  intelSummary,
  nodeFileMap,
  priorityQueue,
  sharedEntities,
  witnessColumns,
  witnessHandle,
  witnessProfiles,
} from "./dep-intel.ts";

const analysis: DepAnalysis = {
  ...EMPTY_ANALYSIS,
  witnesses: [
    {
      id: "w1",
      name: "Dr. Jane Smith, M.D.",
      role: "deponent",
      fileName: "Smith.pdf",
      summary: "",
      quote: "",
      cite: "",
    },
  ],
  contradictions: [
    {
      id: "c1",
      title: "Notice",
      summary: "Disagree on notice",
      a: { witness: "Smith", quote: "yes", cite: "2:20", fileName: "Smith.pdf" },
      b: { witness: "Jones", quote: "no", cite: "2:11", fileName: "Jones.pdf" },
      tags: ["notice"],
    },
    {
      id: "c2",
      title: "Omission",
      summary: "Not asked",
      a: { witness: "Smith", quote: "n/a", cite: "4:1", fileName: "Smith.pdf" },
      b: { witness: "Jones", quote: "n/a", cite: "4:2", fileName: "Jones.pdf" },
      tags: ["omission"],
    },
  ],
  graph: {
    nodes: [{ id: "p1", label: "Jane Smith", kind: "person" }],
    edges: [],
  },
};

/** Two witnesses, one shared organisation, one entity each mentions alone. */
const twoWitness: DepAnalysis = {
  ...EMPTY_ANALYSIS,
  witnesses: [
    {
      id: "w1",
      name: "Jane Smith",
      role: "engineer",
      fileName: "Smith.pdf",
      summary: "",
      quote: "",
      cite: "",
    },
    {
      id: "w2",
      name: "Robert Jones",
      role: "manager",
      fileName: "Jones.pdf",
      summary: "",
      quote: "",
      cite: "",
    },
  ],
  admissions: [
    {
      id: "a1",
      title: "No designee on recall",
      summary: "Nobody was prepared on the recall topic.",
      quote: "I don't know who handled that.",
      cite: "40:3",
      tags: ["30(b)(6)"],
      value: "neutral",
      use: "gap",
    },
  ],
  contradictions: [
    {
      id: "c1",
      title: "Year the recall began",
      summary: "Smith says 2019, Jones says 2021.",
      a: { witness: "Jane Smith", quote: "2019", cite: "12:4", fileName: "Smith.pdf" },
      b: { witness: "Robert Jones", quote: "2021", cite: "8:15", fileName: "Jones.pdf" },
      tags: ["knowledge"],
    },
  ],
  graph: {
    nodes: [
      { id: "smith", label: "Jane Smith", kind: "person" },
      { id: "jones", label: "Robert Jones", kind: "person" },
      { id: "acme", label: "Acme Corp", kind: "org" },
      { id: "memo", label: "Safety memo", kind: "doc" },
      { id: "audit", label: "2020 audit", kind: "event" },
      { id: "orphan", label: "Unrelated LLC", kind: "org" },
    ],
    edges: [
      {
        from: "smith",
        to: "acme",
        label: "worked at",
        cite: "3:1",
        fileName: "Smith.pdf",
        evidenceStatus: "source_matched",
      },
      {
        from: "jones",
        to: "acme",
        label: "managed",
        cite: "5:2",
        fileName: "Jones.pdf",
        evidenceStatus: "source_matched",
      },
      {
        from: "smith",
        to: "memo",
        label: "authored",
        cite: "6:1",
        fileName: "Smith.pdf",
        evidenceStatus: "source_matched",
      },
      {
        from: "jones",
        to: "audit",
        label: "attended",
        cite: "9:4",
        fileName: "Jones.pdf",
        evidenceStatus: "source_matched",
      },
      {
        from: "smith",
        to: "jones",
        label: "corroborates on recall timing",
        cite: "12:4",
        fileName: "Smith.pdf",
        evidenceStatus: "source_matched",
      },
    ],
  },
};

const twoCols = witnessColumns(twoWitness, [
  { fileName: "Smith.pdf", witness: "Jane Smith" },
  { fileName: "Jones.pdf", witness: "Robert Jones" },
]);

test("witnessHandle drops professional suffixes", () => {
  assert.equal(witnessHandle("Dr. Jane Smith, M.D."), "Smith");
  assert.equal(witnessHandle("Robert Jones Jr."), "Jones");
  assert.equal(witnessHandle("Ann Lee, Ph.D., Esq."), "Lee");
  assert.equal(witnessHandle("Minh Do"), "Do");
  assert.equal(witnessHandle("Smith.pdf"), "Smith");
  assert.equal(witnessHandle("Jones Deposition Vol 1.PDF"), "1");
});

test("conflictSeverity treats notice conflicts as high and omissions as low", () => {
  assert.equal(conflictSeverity(analysis.contradictions[0]!), "high");
  assert.equal(conflictSeverity(analysis.contradictions[1]!), "low");
});

test("priorityQueue ranks high conflicts first and labels omissions", () => {
  const queue = priorityQueue(analysis);
  assert.equal(queue[0]?.id, "c1");
  assert.equal(queue[0]?.kind, "conflict");
  assert.equal(queue[0]?.other?.cite, "2:11");
  assert.equal(queue[1]?.kind, "omission");
  assert.equal(queue.length, 2);
});

test("priorityQueue includes 30(b)(6) gaps after conflicts of equal severity", () => {
  const queue = priorityQueue(twoWitness);
  assert.deepEqual(
    queue.map((issue) => issue.kind),
    ["conflict", "gap"],
  );
  assert.equal(queue[1]?.cite, "40:3");
});

test("intelSummary counts witnesses and conflicts from the record", () => {
  const summary = intelSummary(analysis, [
    { fileName: "Smith.pdf", witness: "Jane Smith" },
    { fileName: "Jones.pdf", witness: "Robert Jones" },
  ]);
  assert.equal(summary.conflicts, 2);
  assert.equal(summary.witnesses, 2);
  assert.equal(summary.high, 1);
});

test("nodeFileMap attributes entities only to explicit source evidence", () => {
  const files = nodeFileMap(twoWitness, twoCols);
  assert.deepEqual(files.get("acme"), ["Smith.pdf", "Jones.pdf"]);
  assert.deepEqual(files.get("memo"), ["Smith.pdf"]);
  assert.deepEqual(files.get("audit"), ["Jones.pdf"]);
  assert.deepEqual(files.get("orphan"), []);
  // A relationship mentioned in Smith's file does not imply Jones discussed Smith.
  assert.deepEqual(files.get("smith"), ["Smith.pdf"]);
});

test("sharedEntities keeps only multi-transcript nodes and ranks conflicted witnesses first", () => {
  const shared = sharedEntities(twoWitness, twoCols);
  const ids = shared.map((row) => row.node.id);
  assert.ok(ids.includes("acme"));
  assert.ok(!ids.includes("memo"));
  assert.ok(!ids.includes("orphan"));
  assert.ok(shared[0]!.conflicted, "a contradiction endpoint sorts first");
  const acme = shared.find((row) => row.node.id === "acme")!;
  assert.equal(acme.mentions["Smith.pdf"], 1);
  assert.equal(acme.mentions["Jones.pdf"], 1);
  assert.equal(acme.degree, 2);
});

test("witnessProfiles scores connection and normalises centrality to 100", () => {
  const profiles = witnessProfiles(twoWitness, twoCols);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0]!.centrality, 100);
  for (const profile of profiles) {
    assert.equal(profile.conflicts, 1);
    assert.equal(profile.corroborations, 1);
    assert.equal(profile.connectedTo.length, 1);
    assert.ok(profile.shared >= 1);
  }
});

test("compareWitnesses splits shared and exclusive entities and finds the pair's conflicts", () => {
  const cmp = compareWitnesses(twoWitness, "Smith.pdf", "Jones.pdf", twoCols);
  assert.deepEqual(
    cmp.onlyA.map((node) => node.id),
    ["smith", "memo"],
  );
  assert.deepEqual(
    cmp.onlyB.map((node) => node.id),
    ["audit"],
  );
  assert.ok(cmp.shared.some((node) => node.id === "acme"));
  assert.equal(cmp.conflicts.length, 1);
  assert.equal(cmp.corroborations.length, 1);
});

test("single-transcript sets produce no shared entities", () => {
  assert.equal(sharedEntities(analysis).length, 0);
});
