import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MAX_TOTAL_PX, describeFit, fitTableColumns, sampleRows } from "./table-finish.ts";

const LONG = "Email chain among outside counsel, in-house counsel and the regulatory affairs team discussing the draft response to the FDA warning letter and the litigation hold; reflects legal advice.";
const PARTICIPANTS = "J. Smith (counsel); A. Patel (regulatory); M. Chen (VP Quality); R. Gomez (outside counsel, Seeger Weiss LLP); D. Lee (paralegal)";

const log = [
  ["Bates", "Date", "Custodian", "Description", "Privilege Basis", "Additional Participants"],
  ["ACME-0001234", "2022-10-06", "Patel, A.", LONG, "Attorney-Client", PARTICIPANTS],
  ["ACME-0001235", "2022-10-07", "Chen, M.", "Memo re: labeling change", "Work Product", ""],
  ["ACME-0001236", "2022-11-19", "Smith, J.", LONG.slice(0, 120), "Attorney-Client; Work Product", "R. Gomez (outside counsel)"],
];

test("a privilege log: atomic columns snug and unwrapped, prose columns wide and wrapped", () => {
  const fits = fitTableColumns(log);
  const by = (i: number) => fits[i]!;
  assert.equal(by(0).kind, "atomic"); // Bates
  assert.equal(by(0).wrap, false);
  assert.ok(by(0).widthPx >= 90 && by(0).widthPx <= 130, `bates ${by(0).widthPx}`);
  assert.equal(by(1).kind, "atomic"); // Date
  assert.equal(by(1).wrap, false, "a date never wraps vertically");
  assert.ok(by(1).widthPx >= 80 && by(1).widthPx <= 120, `date ${by(1).widthPx}`);
  assert.equal(by(2).kind, "short"); // Custodian
  assert.equal(by(3).kind, "text"); // Description
  assert.ok(by(3).wrap && by(3).widthPx >= 300, `description ${by(3).widthPx}`);
  assert.equal(by(5).kind, "text"); // Additional Participants
  assert.ok(by(5).wrap && by(5).widthPx >= 300);
  assert.ok(fits.reduce((n, f) => n + f.widthPx, 0) <= DEFAULT_MAX_TOTAL_PX);
  assert.match(describeFit(fits, (i) => "ABCDEF"[i]!), /^finish_table: 6 columns fitted \(A \d+px, B \d+px, .*D \d+px wrap/);
});

test("a long header over a short column wraps the header instead of widening the column", () => {
  const fits = fitTableColumns([
    ["Production Date (per Custodian Certification)", "Amount"],
    ["2022-10-06", "$1,200.50"],
    ["2022-10-07", "$300.00"],
  ]);
  assert.equal(fits[0]!.kind, "atomic");
  assert.ok(fits[0]!.widthPx <= 160, `date col ${fits[0]!.widthPx}`);
  assert.equal(fits[0]!.wrap, true, "header wraps");
  assert.equal(fits[1]!.kind, "atomic");
  assert.equal(fits[1]!.wrap, false);
});

test("the total budget shrinks prose columns first and never below the floor", () => {
  const rows = [["A", "B", "C", "D", "E"], ...Array.from({ length: 5 }, () => [LONG, LONG, LONG, LONG, LONG])];
  const fits = fitTableColumns(rows, { maxTotalWidthPx: 900 });
  const total = fits.reduce((n, f) => n + f.widthPx, 0);
  assert.ok(total <= 900 + 5, `total ${total}`);
  for (const f of fits) assert.ok(f.widthPx >= 160 && f.wrap);
});

test("sampling keeps header rows and spreads body rows deterministically", () => {
  const rows = Array.from({ length: 5_000 }, (_, i) => [i === 0 ? "Header" : `row ${i}`]);
  const s = sampleRows(rows, 1);
  assert.equal(s[0]![0], "Header");
  assert.ok(s.length <= 401);
  assert.deepEqual(sampleRows(rows, 1), s, "deterministic");
  assert.deepEqual(sampleRows(rows.slice(0, 50), 1), rows.slice(0, 50));
});

test("empty and blank columns get the floor width and no wrap", () => {
  const fits = fitTableColumns([["Notes", ""], ["", ""]]);
  assert.equal(fits[1]!.widthPx >= 56, true);
  assert.equal(fits[1]!.wrap, false);
});
