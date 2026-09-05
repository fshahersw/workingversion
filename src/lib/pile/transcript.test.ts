import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blocksToPages,
  formatCite,
  looksLikeTranscript,
  normalizeTranscriptText,
  pageNeedsDepOcr,
  parseTranscript,
  transcriptFromPages,
} from "./transcript.ts";

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

const WORD_NO_LINES = `
DEPOSITION OF JANE SMITH

Q. Please state your name.
A. Jane Smith.
Q. Where do you work?
A. Acme Corp.
`;

const MOTION = `
UNITED STATES DISTRICT COURT
Plaintiff moves to exclude the expert under Daubert.
The motion should be granted for the reasons below.
`;

test("looksLikeTranscript accepts ASCII, Word Q&A, and rejects a motion", () => {
  assert.equal(looksLikeTranscript(ASCII), true);
  assert.equal(looksLikeTranscript(WORD_NO_LINES), true);
  assert.equal(looksLikeTranscript(MOTION), false);
});

test("ASCII parse keeps printed page and line, not a reflowed chunk", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  assert.equal(parsed.citeReady, true);
  assert.equal(parsed.witness, "JANE SMITH");
  assert.ok(parsed.lines.some((l) => l.page === 1 && l.line === 1 && /state your name/i.test(l.text)));
  assert.ok(parsed.lines.some((l) => l.page === 2 && l.line === 2 && /2019/.test(l.text)));
});

test("Q&A blocks carry a page:line cite across a page break", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  const work = parsed.blocks.find((b) => /where do you work/i.test(b.question));
  assert.ok(work);
  assert.equal(work!.cite, "1:3-1:5");
  assert.match(work!.answer, /Acme Corp/);
  assert.match(work!.answer, /ten years/);
  const product = parsed.blocks.find((b) => /see the product/i.test(b.question));
  assert.equal(product?.cite, "2:1-2:2");
});

test("Word without line numbers is accepted but not cite-ready", () => {
  const parsed = parseTranscript(WORD_NO_LINES, "smith.docx");
  assert.equal(parsed.citeReady, false);
  assert.ok(parsed.blocks.length >= 2);
  assert.match(parsed.blocks[0]!.question, /state your name/i);
  assert.match(parsed.blocks[0]!.answer, /Jane Smith/);
});

test("formatCite writes a single line as 45:12 and a range as 45:12-46:3", () => {
  assert.equal(formatCite(45, 12, 45, 12), "45:12");
  assert.equal(formatCite(45, 12, 46, 3), "45:12-46:3");
});

test("blocksToPages keeps one pile page per printed page for search", () => {
  const parsed = parseTranscript(ASCII, "smith.txt");
  const pages = blocksToPages(parsed, "f1", "smith.txt");
  assert.equal(pages[0]?.page, 1);
  assert.match(pages[0]?.text ?? "", /Please state your name/);
  assert.equal(pages.at(-1)?.page, 2);
});

test("normalizeTranscriptText recovers glued and spaced Q&A from dirty PDFs", () => {
  const dirty = "CONFIDENTIAL\n1Q. Please state your name.\n2 A . Jane Smith.\nPage 1 of 44\n3 Q: Where do you work?";
  const clean = normalizeTranscriptText(dirty);
  assert.match(clean, /1 Q\. Please state your name/);
  assert.match(clean, /2 A\. Jane Smith/);
  assert.match(clean, /3 Q\. Where do you work/);
  assert.equal(looksLikeTranscript(dirty), true);
  const parsed = parseTranscript(dirty, "scan.pdf");
  assert.ok(parsed.lines.some((l) => l.line === 1 && /state your name/i.test(l.text)));
  assert.ok(parsed.lines.some((l) => l.speaker === "A" && /Jane Smith/i.test(l.text)));
});

test("transcriptFromPages keeps printed page numbers when each PDF page is separate", () => {
  const parsed = transcriptFromPages(
    [
      { page: 4, text: "    1    Q.    Did you review the memo?\n    2    A.    Yes, in 2004." },
      { page: 5, text: "    1    Q.    And you kept a copy?\n    2    A.    I did." },
    ],
    "scan.pdf",
  );
  assert.ok(parsed.lines.some((l) => l.page === 4 && /memo/i.test(l.text)));
  assert.ok(parsed.lines.some((l) => l.page === 5 && /copy/i.test(l.text)));
  assert.equal(parsed.citeReady, true);
});

test("pageNeedsDepOcr flags empty and garbled pages, not lined Q&A or captions", () => {
  assert.equal(pageNeedsDepOcr(""), true);
  assert.equal(pageNeedsDepOcr("asdf %% ~~ 12 34"), true);
  assert.equal(pageNeedsDepOcr(ASCII), false);
  assert.equal(
    pageNeedsDepOcr("CONFIDENTIAL — Deposition of Jane Smith\nTaken January 15, 2024\nAppearances: MR. JONES"),
    false,
  );
});

test("transcriptFromPages keeps a scanned PDF with no Q&A instead of rejecting it", () => {
  const parsed = transcriptFromPages(
    [
      { page: 1, text: "CONFIDENTIAL — Deposition of Jane Smith\nTaken January 15, 2024" },
      { page: 2, text: "The witness identified the 2003 safety memorandum." },
    ],
    "smith.pdf",
  );
  assert.ok(parsed.lines.length >= 2);
  assert.equal(parsed.fileName, "smith.pdf");
  assert.match(parsed.caption || parsed.lines[0]!.text, /Jane Smith|memorandum/i);
});

test("a lone page number after a full 25-line page starts a new page", () => {
  const page1 = Array.from({ length: 25 }, (_, i) => `     ${i + 1}         Q.    Line ${i + 1} of testimony.`).join("\n");
  const text = `${page1}\n                    2\n     1         Q.    Next page question.\n     2         A.    Next page answer.\n`;
  const parsed = parseTranscript(text, "dense.txt");
  const p2 = parsed.lines.filter((l) => l.page === 2);
  assert.equal(p2.length, 2);
  assert.match(p2[0]!.text, /Next page question/);
});

test("an unindented low number after a short page is not a page break", () => {
  // Documents the isPageHeader heuristic: an unindented lone number with
  // lastLineNo < 20 is ambiguous, so it is folded into the previous answer
  // instead of opening a new page.
  const text = `     1         Q.    Short question.\n     2         A.    Short answer.\n2\n     1         Q.    Follow-up.\n`;
  const parsed = parseTranscript(text, "short.txt");
  assert.ok(parsed.lines.every((l) => l.page === 1));
  assert.equal(parsed.lines.length, 3);
  assert.match(parsed.lines[1]!.text, /Short answer\. 2$/);
});
