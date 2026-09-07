import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acceptDepositionRecordWrite,
  buildDepositionRecord,
  DEPOSITION_RECORD_VERSION,
  depositionWorkspaceName,
  kbSourcesToDepositionHits,
  parseDepositionRecord,
} from "./deposition-record.ts";
import { EMPTY_ANALYSIS, type DepAnalysis } from "../pile/deposition-analysis.ts";
import type { TranscriptLine } from "../pile/transcript.ts";

const RUN_ID = "6f1d2c3a-4b5e-4f70-8a9b-0c1d2e3f4a5b";

const analysis: DepAnalysis = {
  ...EMPTY_ANALYSIS,
  role: "30(b)(6)",
  summary: "Corporate designee on labeling.",
  admissions: [
    {
      id: "adm-0",
      title: "Knew of the 2015 complaint",
      summary: "Use on notice.",
      quote: "Yes, I saw that complaint in 2015.",
      cite: "12:4",
      tags: ["notice"],
      value: "high",
      use: "notice",
    },
  ],
  graph: {
    nodes: [
      { id: "n-smith", label: "Jane Smith", kind: "person" },
      { id: "n-acme", label: "Acme Corp", kind: "org" },
    ],
    edges: [{ from: "n-smith", to: "n-acme", label: "employed by", cite: "5:2" }],
  },
  dropped: 3,
};

function record(overrides: Partial<Parameters<typeof buildDepositionRecord>[0]> = {}) {
  return buildDepositionRecord({
    runId: RUN_ID,
    runStartedAt: 1_700_000_000_000,
    complete: true,
    instructions: "Focus on notice.",
    transcripts: [
      {
        docId: "doc-1",
        fileName: "smith.pdf",
        witness: "Jane Smith",
        citeReady: true,
        lineCount: 400,
      },
    ],
    passes: { case: "done", record: "done", connections: "done", cross: "idle" },
    analysis,
    ...overrides,
  });
}

describe("parseDepositionRecord", () => {
  test("round-trips a built record through JSON", () => {
    const parsed = parseDepositionRecord(JSON.parse(JSON.stringify(record())));
    assert.ok(parsed);
    assert.equal(parsed.version, DEPOSITION_RECORD_VERSION);
    assert.equal(parsed.runId, RUN_ID);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.instructions, "Focus on notice.");
    assert.deepEqual(parsed.transcripts, [
      {
        docId: "doc-1",
        fileName: "smith.pdf",
        witness: "Jane Smith",
        citeReady: true,
        lineCount: 400,
      },
    ]);
    assert.deepEqual(parsed.passes, {
      case: "done",
      record: "done",
      connections: "done",
      cross: "idle",
    });
    assert.equal(parsed.analysis.role, "30(b)(6)");
    assert.equal(parsed.analysis.admissions.length, 1);
    assert.equal(parsed.analysis.admissions[0]!.cite, "12:4");
    assert.equal(parsed.analysis.admissions[0]!.value, "high");
    assert.deepEqual(
      parsed.analysis.graph.nodes.map((n) => n.id),
      ["n-smith", "n-acme"],
    );
    assert.equal(parsed.analysis.graph.edges[0]!.label, "employed by");
    assert.equal(parsed.analysis.dropped, 3);
  });

  test("rejects envelopes that are not trustworthy", () => {
    assert.equal(parseDepositionRecord(null), null);
    assert.equal(parseDepositionRecord("{}"), null);
    assert.equal(parseDepositionRecord({ ...record(), version: 2 }), null);
    assert.equal(parseDepositionRecord({ ...record(), runId: "not-a-uuid" }), null);
    assert.equal(parseDepositionRecord({ ...record(), runStartedAt: "yesterday" }), null);
    assert.equal(parseDepositionRecord({ ...record(), transcripts: [] }), null);
    assert.equal(parseDepositionRecord({ ...record(), transcripts: [{ fileName: "x" }] }), null);
    assert.equal(parseDepositionRecord({ ...record(), analysis: "summary text" }), null);
  });

  test("normalizes unknown pass states and strips malformed analysis fields", () => {
    const parsed = parseDepositionRecord({
      ...record(),
      passes: { case: "flying", record: "done" },
      analysis: {
        ...analysis,
        admissions: [...analysis.admissions, { title: "" }, 42],
        graph: { nodes: [{ kind: "org" }], edges: [{ from: "a" }] },
        bogus: true,
      },
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.passes, {
      case: "idle",
      record: "done",
      connections: "idle",
      cross: "idle",
    });
    assert.equal(parsed.analysis.admissions.length, 1);
    assert.equal(parsed.analysis.graph.nodes.length, 0);
    assert.equal(parsed.analysis.graph.edges.length, 0);
    assert.equal("bogus" in parsed.analysis, false);
  });

  test("removes control characters from stored strings", () => {
    const parsed = parseDepositionRecord({
      ...record(),
      instructions: "notice\u0007 only",
      transcripts: [
        { docId: "d", fileName: "a\u0000b.pdf", witness: "", citeReady: "yes", lineCount: -1 },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.instructions, "notice only");
    assert.deepEqual(parsed.transcripts[0], {
      docId: "d",
      fileName: "a b.pdf",
      witness: "",
      citeReady: false,
      lineCount: 0,
    });
  });
});

describe("acceptDepositionRecordWrite", () => {
  const stored = { runId: RUN_ID, runStartedAt: 2_000, complete: true };
  test("accepts the first write and updates from the same run", () => {
    assert.equal(acceptDepositionRecordWrite(null, { runId: RUN_ID, runStartedAt: 1 }), true);
    assert.equal(acceptDepositionRecordWrite(stored, { runId: RUN_ID, runStartedAt: 1 }), true);
  });
  test("accepts a newer run and rejects an older one", () => {
    assert.equal(
      acceptDepositionRecordWrite(stored, { runId: "other", runStartedAt: 3_000 }),
      true,
    );
    assert.equal(
      acceptDepositionRecordWrite(stored, { runId: "other", runStartedAt: 1_000 }),
      false,
    );
  });
});

describe("depositionWorkspaceName", () => {
  test("prefers witness names and falls back to file stems", () => {
    assert.equal(
      depositionWorkspaceName([
        { fileName: "smith.pdf", witness: "Jane Smith" },
        { fileName: "jones-depo.pdf", witness: "" },
      ]),
      "Jane Smith, jones-depo · Depositions",
    );
    assert.equal(
      depositionWorkspaceName([{ fileName: "smith.pdf", witness: "Jane Smith" }]),
      "Jane Smith · Deposition",
    );
    assert.equal(depositionWorkspaceName([]), "Deposition");
  });
  test("collapses long sets", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ fileName: `w${i}.pdf`, witness: `W${i}` }));
    assert.equal(depositionWorkspaceName(many), "W0, W1, W2 +3 · Depositions");
  });
});

describe("kbSourcesToDepositionHits", () => {
  const lines: TranscriptLine[] = [
    { page: 12, line: 1, text: "Q. Did you see the complaint?", speaker: "Q" },
    { page: 12, line: 2, text: "A. Yes, I saw that complaint in 2015.", speaker: "A" },
    { page: 12, line: 3, text: "Q. Who sent it?", speaker: "Q" },
    { page: 13, line: 1, text: "A. Regulatory affairs.", speaker: "A" },
  ] as TranscriptLine[];
  const transcripts = [{ fileId: "file-a", docId: "doc-1", fileName: "smith.pdf", lines }];

  test("snaps a source to the matching transcript line", () => {
    const hits = kbSourcesToDepositionHits(
      [
        {
          ref: "S1",
          chunkId: 9,
          docId: "doc-1",
          fileName: "smith.pdf",
          page: 12,
          pageEnd: null,
          kind: null,
          text: "A. Yes, I saw that complaint in 2015. Q. Who sent it?",
          conf: null,
          score: 0.8,
        },
      ],
      transcripts,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.fileId, "file-a");
    assert.equal(hits[0]!.cite, "12:2");
    assert.equal(hits[0]!.startLine, 2);
    assert.equal(hits[0]!.score, 0.8);
  });

  test("falls back to the first line of the page and drops unknown documents", () => {
    const hits = kbSourcesToDepositionHits(
      [
        {
          ref: "S1",
          chunkId: 1,
          docId: "doc-1",
          fileName: "smith.pdf",
          page: 13,
          pageEnd: null,
          kind: null,
          text: "completely different text that is not on the page at all",
          conf: null,
          score: 0.2,
        },
        {
          ref: "S2",
          chunkId: 2,
          docId: "doc-unknown",
          fileName: "x.pdf",
          page: 1,
          pageEnd: null,
          kind: null,
          text: "anything",
          conf: null,
          score: 0.1,
        },
      ],
      transcripts,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.cite, "13:1");
  });
});
