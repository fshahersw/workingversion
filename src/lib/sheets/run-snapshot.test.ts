import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUN_SNAPSHOT_MAX_CELLS,
  addBlock,
  captureSpecForPlan,
  emptyRunSnapshot,
  noteBatch,
  restorability,
  restoreSteps,
  type Bounds,
} from "./run-snapshot.ts";

// Minimal A1 helpers for the tests (0-based, inclusive).
const col = (s: string) => s.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const cell = (a: string): { r: number; c: number } => {
  const m = /^([A-Z]+)(\d+)$/.exec(a)!;
  return { r: Number(m[2]) - 1, c: col(m[1]!) };
};
const parseRange = (range: string): Bounds => {
  const [a, b = a] = range.split(":") as [string, string?];
  const s = cell(a);
  const e = cell(b!);
  return { startRow: Math.min(s.r, e.r), startColumn: Math.min(s.c, e.c), endRow: Math.max(s.r, e.r), endColumn: Math.max(s.c, e.c) };
};
const h = { parseRange, columnIndex: col };

test("a table-building batch: cell edits collapse to a dense box, fill/format ranges, widths, deferred query", () => {
  const spec = captureSpecForPlan(
    {
      cellChanges: [
        { sheetId: "s1", address: "A1" },
        { sheetId: "s1", address: "B1" },
        { sheetId: "s1", address: "A2" },
        { sheetId: "s1", address: "B2" },
      ],
      formatChanges: [{ sheetId: "s1", range: "A1:F1" }],
      structuralChanges: [
        { op: { op: "fill_range", sheetId: "s1", source: "C2:C2", target: "C2:C80000" } },
        { op: { op: "set_col_width", sheetId: "s1", column: "D", count: 3 } },
        { op: { op: "query_range", sheetId: "s1", source: "A1:F80000", target: "K1" } },
        { op: { op: "add_chart", sheetId: "s1" } },
      ],
      sheetRenames: [{ sheetId: "s1", before: "Sheet1" }],
    },
    h,
  );
  assert.deepEqual(spec.blocks[0], { sheetId: "s1", bounds: { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 }, reason: "cell edits" });
  assert.ok(spec.blocks.some((b) => b.reason === "format" && b.bounds.endColumn === 5));
  assert.ok(spec.blocks.some((b) => b.reason === "fill_range" && b.bounds.endRow === 79_999));
  assert.deepEqual(spec.columns.map((c) => c.column), [3, 4, 5]);
  assert.deepEqual(spec.deferred, ["query_range"]);
  assert.deepEqual(spec.notReverted, ["add_chart"]);
  assert.deepEqual(spec.renames, [{ sheetId: "s1", name: "Sheet1" }]);
  assert.deepEqual(spec.unrestorable, []);
});

test("sparse far-apart cell edits stay individual instead of snapshotting the whole sheet", () => {
  const spec = captureSpecForPlan(
    { cellChanges: [{ sheetId: "s1", address: "A1" }, { sheetId: "s1", address: "ZZ9999" }], formatChanges: [], structuralChanges: [], sheetRenames: [] },
    h,
  );
  assert.equal(spec.blocks.length, 2);
  assert.ok(spec.blocks.every((b) => b.bounds.startRow === b.bounds.endRow));
});

test("copy_range with a single-cell target captures a block the size of the source", () => {
  const spec = captureSpecForPlan(
    { cellChanges: [], formatChanges: [], structuralChanges: [{ op: { op: "copy_range", sheetId: "s1", source: "A1:C10", target: "H5" } }], sheetRenames: [] },
    h,
  );
  assert.deepEqual(spec.blocks[0]!.bounds, { startRow: 4, startColumn: 7, endRow: 13, endColumn: 9 });
});

test("structural ops make the run unrestorable; the reason names them", () => {
  const spec = captureSpecForPlan(
    { cellChanges: [], formatChanges: [], structuralChanges: [{ op: { op: "insert_rows", sheetId: "s1", row: 3, count: 2 } }], sheetRenames: [] },
    h,
  );
  const snap = emptyRunSnapshot();
  noteBatch(snap, spec);
  const r = restorability(snap);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /insert_rows/);
});

test("the cell cap truncates and refuses rollback instead of half-reverting", () => {
  const snap = emptyRunSnapshot();
  const big = { sheetId: "s1", bounds: { startRow: 0, startColumn: 0, endRow: 99_999, endColumn: 9 }, cells: [], reason: "fill_range" }; // 1,000,000 cells
  assert.equal(addBlock(snap, big), true);
  assert.equal(snap.cells, RUN_SNAPSHOT_MAX_CELLS);
  const one = { sheetId: "s1", bounds: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }, cells: [[null]], reason: "cell" };
  assert.equal(addBlock(snap, one), false);
  assert.equal(snap.truncated, true);
  const r = restorability(snap);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /could not be held/);
});

test("restore order: newest block first, first-captured widths win, merges reversed, renames deduped", () => {
  const snap = emptyRunSnapshot();
  addBlock(snap, { sheetId: "s1", bounds: parseRange("A1:B2"), cells: [[null, null], [null, null]], reason: "first" });
  addBlock(snap, { sheetId: "s1", bounds: parseRange("A1:A1"), cells: [[{ v: 1 }]], reason: "second" });
  snap.columnWidths.push({ sheetId: "s1", column: 0, widthPx: 64 }, { sheetId: "s1", column: 0, widthPx: 200 });
  snap.merges.push({ sheetId: "s1", range: "A1:B1", wasMerged: false }, { sheetId: "s1", range: "C1:D1", wasMerged: true });
  snap.renames.push({ sheetId: "s1", name: "Sheet1" }, { sheetId: "s1", name: "Renamed once" });
  const steps = restoreSteps(snap);
  assert.equal(steps[0]!.kind, "block");
  assert.equal((steps[0] as { block: { reason: string } }).block.reason, "second");
  assert.equal((steps[1] as { block: { reason: string } }).block.reason, "first");
  const width = steps.find((s) => s.kind === "colWidth") as { item: { widthPx: number } };
  assert.equal(width.item.widthPx, 64, "pre-run width");
  const merges = steps.filter((s) => s.kind === "merge") as Array<{ item: { range: string } }>;
  assert.deepEqual(merges.map((m) => m.item.range), ["C1:D1", "A1:B1"]);
  assert.equal(steps.filter((s) => s.kind === "rename").length, 1);
  const r = restorability(snap);
  assert.equal(r.ok, true);
});

test("a run that added visuals restores with a caveat; an empty run has nothing to revert", () => {
  const snap = emptyRunSnapshot();
  addBlock(snap, { sheetId: "s1", bounds: parseRange("A1:A1"), cells: [[null]], reason: "cell" });
  noteBatch(snap, { unrestorable: [], notReverted: ["add_chart"] });
  const r = restorability(snap);
  assert.equal(r.ok, true);
  assert.match((r as { caveat: string }).caveat, /add_chart/);
  assert.equal(restorability(emptyRunSnapshot()).ok, false);
});
