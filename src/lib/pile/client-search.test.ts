import assert from "node:assert/strict";
import { test } from "node:test";

import { searchPages } from "./client-search.ts";
import { ASK_MIN_HITS, ASK_PACK_CHARS, askBudget, perFileHits } from "./limits.ts";
import { PileIndex } from "./pile-index.ts";
import type { PilePage } from "./types.ts";

test("browser search finds the Daubert page without a server session", () => {
  const pages: PilePage[] = [
    { fileId: "f1", fileName: "motion.pdf", page: 1, text: "Certificate of service.", ocr: false },
    {
      fileId: "f1",
      fileName: "motion.pdf",
      page: 12,
      text: "The court excludes the expert under Daubert.",
      ocr: false,
    },
  ];
  const hits = searchPages(pages, "Daubert expert", 4);
  assert.equal(hits[0]?.page, 12);
});

test("a short file with the only true match is not crowded out by a huge noisy file", () => {
  const pages: PilePage[] = [];
  for (let i = 1; i <= 400; i += 1) {
    pages.push({
      fileId: "big",
      fileName: "omnibus.pdf",
      page: i,
      text: "Certificate of service. Notice of appearance. Daubert briefing schedule reference.",
      ocr: false,
    });
  }
  pages.push({
    fileId: "small",
    fileName: "order.pdf",
    page: 2,
    text: "The court GRANTS the motion and excludes Dr. Reyes under Daubert as unreliable.",
    ocr: false,
  });

  const index = new PileIndex();
  index.addPages(pages);
  const groups = index.searchByFile("Daubert exclude Reyes", 5);
  const small = groups.find((g) => g.fileId === "small");
  assert.ok(small?.matched, "the short file must report its own hits");
  assert.equal(small?.hits[0]?.page, 2);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.hits.length <= 5));
});

test("packAskByFile returns a pack for every file, even one with no keyword match", () => {
  const index = new PileIndex();
  index.addPages([
    { fileId: "a", fileName: "a.pdf", page: 1, text: "Daubert exclusion of the expert.", ocr: false },
    { fileId: "b", fileName: "b.pdf", page: 1, text: "Unrelated shipping invoice totals.", ocr: false },
  ]);
  const packs = index.packAskByFile("Daubert exclusion");
  assert.equal(packs.length, 2);
  assert.ok(packs.every((p) => p.pages.length > 0));
  assert.equal(packs.find((p) => p.fileId === "b")?.matched, false);
});

test("askBudget scales retrieval with file count", async () => {
  const { askBudget, ASK_PACK_CHARS } = await import("./limits.ts");
  const b1 = askBudget(1);
  assert.equal(b1.singlePack, 24);
  const b4 = askBudget(4);
  assert.equal(b4.fanoutFiles, 4);
  assert.equal(b4.writerPack, 60);
  const b12 = askBudget(12);
  assert.equal(b12.fanoutFiles, 12);
  assert.equal(b12.writerPack, 88);
  const b25 = askBudget(25);
  assert.equal(b25.fanoutFiles, 24);
  assert.equal(b25.perFilePages, 7);
  assert.equal(b25.writerPack, 110);
  const b60 = askBudget(60);
  assert.equal(b60.fanoutFiles, 30);
  assert.equal(b60.perFilePages, 6);
  assert.equal(b60.writerPack, 128);
  // The widest tier still fits under the character ceiling at max page size.
  for (const b of [b1, b4, b12, b25, b60]) {
    assert.ok(b.writerPack * 2000 <= ASK_PACK_CHARS + 2000, "pack must fit the char ceiling");
  }
  // Monotonic: more files never means a smaller writer pack.
  const packs = [1, 4, 12, 25, 60].map((n) => askBudget(n).writerPack);
  for (let i = 1; i < packs.length; i += 1) assert.ok(packs[i]! >= packs[i - 1]!);
});

test("packAskByFile honors a scaled per-file page cap", async () => {
  const index = new PileIndex();
  const pages: PilePage[] = [];
  for (const fileId of ["a", "b"]) {
    for (let i = 1; i <= 30; i += 1) {
      pages.push({
        fileId,
        fileName: `${fileId}.pdf`,
        page: i,
        text: `Daubert expert exclusion discussion page ${i}.`,
        ocr: false,
      });
    }
  }
  index.addPages(pages);
  const small = index.packAskByFile("Daubert exclusion", null, 6, 5);
  assert.ok(small.every((p) => p.pages.length <= 5));
  const large = index.packAskByFile("Daubert exclusion", null, 6, 12);
  assert.ok(large.every((p) => p.pages.length <= 12));
  assert.ok(large[0]!.pages.length > small[0]!.pages.length);
});

test("a single-file ask packs 15 cited pages when 15+ are relevant", () => {
  const index = new PileIndex();
  const pages: PilePage[] = [];
  for (let i = 1; i <= 40; i += 1) {
    pages.push({
      fileId: "solo",
      fileName: "solo.pdf",
      page: i,
      text: `Daubert expert exclusion analysis page ${i}.`,
      ocr: false,
    });
  }
  index.addPages(pages);
  const budget = askBudget(1);
  const cap = Math.max(budget.perFilePages, ASK_MIN_HITS);
  assert.equal(cap, 15);
  const packs = index.packAskByFile("Daubert exclusion", null, perFileHits(1), cap);
  assert.equal(packs[0]!.pages.length, 15);
  assert.equal(packs[0]!.hits.length, 15);
});

test("per-file hit budget scales down as the pile grows", () => {
  assert.equal(perFileHits(1), 20);
  assert.equal(perFileHits(4), 10);
  assert.equal(perFileHits(10), 6);
  assert.equal(perFileHits(25), 4);
});

test("ask budgets grow with file count and stay inside the writer ceiling", () => {
  for (const n of [1, 4, 12, 25, 60]) {
    const b = askBudget(n);
    assert.ok(b.fanoutFiles >= 1 && b.fanoutFiles <= Math.max(n, 1));
    assert.ok(b.writerPack * 3500 <= ASK_PACK_CHARS * 2);
  }
  assert.ok(askBudget(60).writerPack > askBudget(4).writerPack);
  assert.ok(askBudget(60).perFilePages <= askBudget(4).perFilePages);
});

test("the relevance floor trims padded low-score hits", () => {
  const pages: PilePage[] = [
    {
      fileId: "f",
      fileName: "f.pdf",
      page: 1,
      text: "Daubert Daubert Daubert exclusion of Dr. Reyes as unreliable.",
      ocr: false,
    },
  ];
  for (let i = 2; i <= 30; i += 1) {
    pages.push({
      fileId: "f",
      fileName: "f.pdf",
      page: i,
      text: "Certificate of service and notice of appearance for the parties.",
      ocr: false,
    });
  }
  const index = new PileIndex();
  index.addPages(pages);
  const groups = index.searchByFile("Daubert Reyes exclusion");
  const hits = groups[0]?.hits ?? [];
  assert.equal(hits[0]?.page, 1);
  assert.ok(hits.length < 20, "noise pages must not pad the list to the budget");
});
