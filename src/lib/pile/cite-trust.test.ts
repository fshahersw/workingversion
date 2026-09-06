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
import type { PileHit, PilePage } from "./types.ts";

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

test("verifyAnswerCites preserves exact, normalized, and fuzzy quote matches", () => {
  const packed = pagesFromPack(pages);
  const exact = verifyAnswerCites(
    'The order says "A Daubert hearing is set for March 14, 2026." [S1].',
    packed,
  );
  const normalized = verifyAnswerCites(
    'The order says "a daubert hearing is set for march 14, 2026." [S1].',
    packed,
  );
  const fuzzy = verifyAnswerCites(
    'The order says "A Daubert hearing is scheduled for March 14, 2026." [S1].',
    packed,
  );

  assert.equal(exact.cites[0]!.match, "exact");
  assert.equal(exact.cites[0]!.label, "cmo-12.pdf p. 4");
  assert.equal(normalized.cites[0]!.match, "normalized");
  assert.equal(fuzzy.cites[0]!.match, "fuzzy");
  assert.equal(exact.verified, 1);
  assert.equal(exact.unverified, 0);
});

test("verifyAnswerCites does not verify a packed cite without a quoted span", () => {
  const packed = pagesFromPack(pages);
  const answer =
    'The order says "A Daubert hearing is set for March 14, 2026." [S1]. Defendants request exclusion under Rule 702 [S2].';
  const report = verifyAnswerCites(answer, packed);

  assert.equal(report.cites[1]!.match, "packed");
  assert.equal(report.cites[1]!.quote, "");
  assert.equal(report.verified, 1);
  assert.equal(report.unverified, 1);
});

test("verifyAnswerCites rejects a real quote cited to the wrong page", () => {
  const packed = pagesFromPack(pages);
  const answer = 'Defendants argue "the expert should be excluded under Rule 702." [S1].';
  const report = verifyAnswerCites(answer, packed);

  assert.equal(report.cites[0]!.match, "none");
  assert.equal(report.verified, 0);
  assert.equal(report.unverified, 1);
});

test("verifyAnswerCites reports OCR and garbled packed pages", () => {
  const hits: PileHit[] = [
    {
      fileId: "a",
      fileName: "cmo-12.pdf",
      page: 4,
      score: 1,
      snippet: "Daubert hearing",
      garbled: true,
    },
  ];
  const packed = pagesFromPack(pages, hits);
  const answer =
    'The order says "A Daubert hearing is set for March 14, 2026." [S1]. Defendants argue "the expert should be excluded under Rule 702." [S2].';
  const report = verifyAnswerCites(answer, packed);

  assert.equal(report.cites[0]!.garbled, true);
  assert.equal(report.cites[1]!.ocr, true);
  assert.equal(report.garbledUsed, true);
  assert.equal(report.ocrUsed, true);
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
