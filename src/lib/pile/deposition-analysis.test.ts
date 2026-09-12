import assert from "node:assert/strict";
import { test } from "node:test";

import {
  depInsights,
  mergeDepAnalysis,
  parseCiteStart,
  parseDepAnalysis,
  quoteInTranscript,
  snapQuote,
  verifyDepAnalysis,
} from "./deposition-analysis.ts";
import { parseTranscript } from "./transcript.ts";

const ASCII = `
                    DEPOSITION OF JANE SMITH
                    Taken January 15, 2024

                                                                1
     1         Q.    Please state your name.
     2         A.    Jane Smith.
     3         Q.    Where do you work?
     4         A.    Acme Corp.
     5               I have been there ten years.

                                                                2
     1         Q.    Did you see the product?
     2         A.    Yes, in 2019.
`;

test("quoteInTranscript matches a verbatim span and rejects invented text", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  assert.equal(quoteInTranscript("I have been there ten years.", parsed.lines), true);
  assert.equal(quoteInTranscript("She admitted the label was false in 2014.", parsed.lines), false);
});

test("parseDepAnalysis reads fenced JSON and verify drops unverified quotes", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  const analysis = parseDepAnalysis(`\`\`\`json
{
  "role": "fact witness",
  "summary": "Jane Smith works at Acme.",
  "admissions": [
    { "title": "Tenure", "quote": "I have been there ten years.", "cite": "1:5" },
    { "title": "Invented", "quote": "The company hid the risk.", "cite": "9:1" }
  ],
  "chronology": [{ "date": "2019", "title": "Saw product", "quote": "Yes, in 2019.", "cite": "2:2" }]
}
\`\`\``);
  assert.equal(analysis.admissions.length, 2);
  const verified = verifyDepAnalysis(analysis, parsed);
  assert.equal(verified.admissions.length, 1);
  assert.equal(verified.dropped, 1);
  assert.equal(verified.chronology[0]?.date, "2019");
});

test("parseCiteStart reads the first page:line", () => {
  assert.deepEqual(parseCiteStart("11:14-11:16"), { page: 11, line: 14 });
  assert.equal(parseCiteStart("no cite"), null);
});

test("snapQuote recovers a real cite from a near-verbatim span", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  const snapped = snapQuote("I have been there ten years at the company", parsed.lines);
  assert.ok(snapped);
  assert.match(snapped!.cite, /^1:5/);
  assert.match(snapped!.quote, /ten years/i);
});

test("parseDepAnalysis reads witnesses, contradictions, and graph", () => {
  const analysis = parseDepAnalysis(`{
    "witnesses": [{ "name": "Jane Smith", "role": "fact", "fileName": "smith.txt", "summary": "Works at Acme." }],
    "contradictions": [{
      "title": "Tenure",
      "summary": "Years at Acme differ.",
      "a": { "witness": "Jane", "quote": "ten years", "cite": "1:5" },
      "b": { "witness": "Jane", "quote": "Yes, in 2019", "cite": "2:2" }
    }],
    "graph": {
      "nodes": [{ "id": "jane", "label": "Jane Smith", "kind": "person" }, { "id": "acme", "label": "Acme", "kind": "org" }],
      "edges": [{ "from": "jane", "to": "acme", "label": "employed by", "cite": "1:4" }]
    }
  }`);
  assert.equal(analysis.witnesses[0]?.name, "Jane Smith");
  assert.equal(analysis.contradictions[0]?.title, "Tenure");
  assert.equal(analysis.graph.nodes.length, 2);
  assert.equal(analysis.graph.edges[0]?.label, "employed by");
  const insights = depInsights(analysis);
  assert.equal(insights.conflicts, 1);
  assert.equal(insights.people, 1);
  assert.equal(insights.edges, 1);
});

test("mergeDepAnalysis dedupes a re-titled duplicate quote from a later pass", () => {
  const base = parseDepAnalysis(`{
    "admissions": [{ "title": "Tenure", "quote": "I have been there ten years.", "cite": "1:5" }],
    "contradictions": [{
      "title": "Tenure conflict",
      "a": { "witness": "Jane", "quote": "ten years", "cite": "1:5" },
      "b": { "witness": "Jane", "quote": "Yes, in 2019", "cite": "2:2" }
    }],
    "witnesses": [{ "name": "Jane Smith", "fileName": "smith.txt" }]
  }`);
  // Synth pass restates the title but quotes the same testimony.
  const next = parseDepAnalysis(`{
    "admissions": [{ "title": "A decade at Acme", "quote": "I have been there ten years.", "cite": "1:5" }],
    "contradictions": [{
      "title": "How long at Acme",
      "a": { "witness": "Jane", "quote": "Yes, in 2019", "cite": "2:2" },
      "b": { "witness": "Jane", "quote": "ten years", "cite": "1:5" }
    }],
    "witnesses": [{ "name": "jane smith", "fileName": "other.txt" }]
  }`);
  const merged = mergeDepAnalysis(base, next);
  assert.equal(merged.admissions.length, 1);
  assert.equal(merged.contradictions.length, 1);
  assert.equal(merged.witnesses.length, 2); // Same witness, distinct source records.
});

test("mergeDepAnalysis keeps distinct findings that share only a cite", () => {
  const base = parseDepAnalysis(`{
    "admissions": [{ "title": "Tenure", "quote": "I have been there ten years.", "cite": "1:5" }]
  }`);
  const next = parseDepAnalysis(`{
    "admissions": [{ "title": "Employer", "quote": "Acme Corp.", "cite": "1:4" }]
  }`);
  const merged = mergeDepAnalysis(base, next);
  assert.equal(merged.admissions.length, 2);
});

test("mergeDepAnalysis keeps summary-only findings without quote or cite", () => {
  const base = parseDepAnalysis(`{
    "themes": [{ "title": "Baseline theme" }]
  }`);
  const next = parseDepAnalysis(`{
    "themes": [{ "title": "Cross-pass synthesis" }]
  }`);
  const merged = mergeDepAnalysis(base, next);
  assert.deepEqual(
    merged.themes.map((item) => item.title),
    ["Baseline theme", "Cross-pass synthesis"],
  );
});

test("verification rejects a contradiction with an invented side", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  const input = parseDepAnalysis(
    JSON.stringify({
      contradictions: [
        {
          title: "Timing",
          a: { fileName: "smith.txt", quote: "I have been there ten years." },
          b: { fileName: "smith.txt", quote: "The company hid the risk." },
        },
      ],
    }),
  );
  const result = verifyDepAnalysis(input, parsed);
  assert.equal(result.contradictions.length, 0);
  assert.ok(result.dropped > 0);
});

test("verification never moves a quote from the named transcript to another file", () => {
  const jane = parseTranscript(ASCII, "smith.txt");
  const other = parseTranscript(
    ASCII.replace("I have been there ten years.", "I joined the company last month."),
    "other.txt",
  );
  const input = parseDepAnalysis(
    JSON.stringify({
      admissions: [
        { title: "Tenure", fileName: "other.txt", quote: "I have been there ten years." },
      ],
    }),
  );
  assert.equal(verifyDepAnalysis(input, [jane, other]).admissions.length, 0);
});

test("graph source verification requires the whole quote and preserves source identity", () => {
  const input = parseDepAnalysis(
    JSON.stringify({
      graph: {
        nodes: [
          { id: "p", label: "Jane Smith", kind: "person" },
          { id: "o", label: "Acme", kind: "org" },
        ],
        edges: [
          {
            from: "p",
            to: "o",
            label: "tenure",
            quote: "I have been there ten years.",
            fileName: "smith.txt",
          },
          {
            from: "p",
            to: "o",
            label: "concealed",
            quote: "I have been there ten years and concealed all the documents.",
            fileName: "smith.txt",
          },
          { from: "p", to: "o", label: "legacy", cite: "1:5" },
        ],
      },
    }),
  );
  const result = verifyDepAnalysis(input, parseTranscript(ASCII, "smith.txt"));
  assert.equal(result.graph.edges[0]?.evidenceStatus, "source_matched");
  assert.equal(result.graph.edges[0]?.fileName, "smith.txt");
  assert.equal(result.graph.edges[0]?.cite, "1:5");
  assert.equal(result.graph.edges[1]?.evidenceStatus, "needs_review");
  assert.equal(result.graph.edges[2]?.evidenceStatus, "needs_review");
});

test("graph merge remaps reused model IDs and equivalent labels without misconnecting nodes", () => {
  const first = parseDepAnalysis(
    JSON.stringify({
      graph: {
        nodes: [
          { id: "1", label: "Jane Smith", kind: "person" },
          { id: "2", label: "Acme", kind: "org" },
        ],
        edges: [{ from: "1", to: "2", label: "works at" }],
      },
    }),
  );
  const second = parseDepAnalysis(
    JSON.stringify({
      graph: {
        nodes: [
          { id: "1", label: "John Jones", kind: "person" },
          { id: "9", label: "ACME", kind: "org" },
        ],
        edges: [{ from: "1", to: "9", label: "works at" }],
      },
    }),
  );
  const result = mergeDepAnalysis(first, second);
  assert.equal(result.graph.nodes.length, 3);
  const labels = new Map(result.graph.nodes.map((n) => [n.id, n.label.toLowerCase()]));
  assert.deepEqual(
    result.graph.edges.map((e) => [labels.get(e.from), labels.get(e.to)]),
    [
      ["jane smith", "acme"],
      ["john jones", "acme"],
    ],
  );
});

test("matching citations in different files remain separate findings", () => {
  const make = (fileName: string) =>
    parseDepAnalysis(
      JSON.stringify({
        admissions: [
          { title: "Tenure", fileName, cite: "1:5", quote: "I have been there ten years." },
        ],
      }),
    );
  assert.equal(mergeDepAnalysis(make("a.txt"), make("b.txt")).admissions.length, 2);
});
