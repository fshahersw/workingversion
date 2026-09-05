import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimNearCite,
  citeLabel,
  pagesFromPack,
  rewriteCites,
  shortFileName,
  verifyAnswerCites,
} from "./cite-trust.ts";
import type { PilePage } from "./types.ts";

const pages: PilePage[] = [
  {
    fileId: "a",
    fileName: "cmo-12.pdf",
    page: 4,
    text: "A Daubert hearing is set for March 14, 2026. General causation remains disputed.",
    ocr: false,
  },
  {
    fileId: "b",
    fileName: "opp.pdf",
    page: 2,
    text: "Defendants argue the expert should be excluded under Rule 702.",
    ocr: true,
  },
];

test("cite labels use file and page, not S-ids", () => {
  assert.equal(citeLabel("cmo-12.pdf", 4), "cmo-12.pdf p. 4");
  assert.ok(shortFileName("very-long-expert-report-name-here.pdf").endsWith(".pdf"));
});

test("verifyAnswerCites keeps a quote that appears on the packed page", () => {
  const packed = pagesFromPack(pages);
  const answer =
    'The order says "Daubert hearing is set for March 14, 2026" [S1]. They argue "the expert should be excluded under Rule 702" [S2].';
  const report = verifyAnswerCites(answer, packed);
  assert.equal(report.cites.length, 2);
  assert.equal(report.cites[0]!.label, "cmo-12.pdf p. 4");
  assert.notEqual(report.cites[0]!.match, "none");
  assert.notEqual(report.cites[1]!.match, "none");
  assert.equal(report.ocrUsed, true);
});

test("verifyAnswerCites flags an invented cite", () => {
  const packed = pagesFromPack(pages);
  const answer = 'The court awarded "$40 million in punitive damages" [S1].';
  const report = verifyAnswerCites(answer, packed);
  assert.equal(report.cites[0]!.match, "none");
  assert.equal(report.unverified, 1);
});

test("claimNearCite prefers a quoted span", () => {
  const q = claimNearCite('The order says "Daubert hearing is set for March 14, 2026" [S1].', "S1");
  assert.match(q, /Daubert hearing/);
});

test("rewriteCites swaps S-ids for file and page", () => {
  const packed = pagesFromPack(pages);
  const out = rewriteCites("Denied [S1].", packed);
  assert.equal(out, "Denied [cmo-12.pdf p. 4].");
});
