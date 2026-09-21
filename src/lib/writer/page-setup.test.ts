import assert from "node:assert/strict";
import { test } from "node:test";

import { PAPER_TWIPS, applyPageSetupPatch, twipsToInches } from "./page-setup.ts";

type S = Parameters<typeof applyPageSetupPatch>[0];

const portraitLetter: S = {
  pageWidth: 12240,
  pageHeight: 15840,
  orientation: "portrait",
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  pageBorder: false,
  columns: 1,
};
const landscapeLegal: S = {
  ...portraitLetter,
  orientation: "landscape",
  pageWidth: 20160,
  pageHeight: 12240,
  marginLeft: 720,
};

test("orientation flip swaps each section's own dimensions and keeps its paper", () => {
  const a = applyPageSetupPatch(portraitLetter, { orientation: "landscape" });
  assert.deepEqual([a.orientation, a.pageWidth, a.pageHeight], ["landscape", 15840, 12240]);
  const b = applyPageSetupPatch(landscapeLegal, { orientation: "portrait" });
  assert.deepEqual([b.orientation, b.pageWidth, b.pageHeight], ["portrait", 12240, 20160]);
  // already in the requested orientation: untouched
  assert.deepEqual(applyPageSetupPatch(landscapeLegal, { orientation: "landscape" }), landscapeLegal);
});

test("margins-only patch leaves orientation and paper alone on every section", () => {
  const patch = { margins: { marginTop: 2880 } };
  const a = applyPageSetupPatch(portraitLetter, patch);
  const b = applyPageSetupPatch(landscapeLegal, patch);
  assert.equal(a.marginTop, 2880);
  assert.equal(b.marginTop, 2880);
  assert.equal(b.orientation, "landscape");
  assert.equal(b.pageWidth, 20160);
  assert.equal(b.marginLeft, 720, "unmentioned margins are kept");
});

test("paper size respects the section's current orientation, then orientation applies", () => {
  const a4 = PAPER_TWIPS["a4"]!;
  const a = applyPageSetupPatch(landscapeLegal, { paper: a4 });
  assert.deepEqual([a.pageWidth, a.pageHeight], [a4.h, a4.w]);
  const b = applyPageSetupPatch(portraitLetter, { paper: a4, orientation: "landscape" });
  assert.deepEqual([b.orientation, b.pageWidth, b.pageHeight], ["landscape", a4.h, a4.w]);
});

test("columns default the gap once and never override an existing one", () => {
  const two = applyPageSetupPatch(portraitLetter, { columns: 2 });
  assert.equal(two.columns, 2);
  assert.equal(two.colSpace, 720);
  const kept = applyPageSetupPatch({ ...portraitLetter, colSpace: 360 }, { columns: 3 });
  assert.equal(kept.colSpace, 360);
  const one = applyPageSetupPatch(two, { columns: 1 });
  assert.equal(one.columns, 1);
});

test("twipsToInches rounds to hundredths", () => {
  assert.equal(twipsToInches(1440), "1");
  assert.equal(twipsToInches(720), "0.5");
  assert.equal(twipsToInches(11906), "8.27");
});
