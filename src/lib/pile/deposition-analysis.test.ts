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
  assert.equal(merged.witnesses.length, 1);
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
