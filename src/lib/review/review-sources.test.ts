import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindingsFromSave,
  hydrationPlan,
  orphanRowIds,
  reviewBatchName,
  upsertSource,
} from "./review-sources.ts";
import type { ReviewRow, ReviewSource } from "./types.ts";

function row(partial: Partial<ReviewRow> & { id: string }): ReviewRow {
  return {
    tableId: "t1",
    label: `${partial.id}.pdf`,
    fileIds: [],
    fingerprint: null,
    pageCount: 3,
    position: 0,
    docId: null,
    workspaceItemId: null,
    ...partial,
  };
}

test("a finished save binds only the rows whose live file was indexed", () => {
  const rows = [
    row({ id: "r1", fileIds: ["f1"] }),
    row({ id: "r2", fileIds: ["f2"] }),
    row({ id: "r3", fileIds: ["f3"], docId: "d-old", workspaceItemId: "w-old" }),
  ];
  const bound = bindingsFromSave(rows, "w1", { f1: "d1", f3: "d3-new" });
  assert.deepEqual(bound, [{ rowId: "r1", docId: "d1", workspaceItemId: "w1" }]);
});

test("hydration fetches only bound rows that are not live, grouped by workspace", () => {
  const rows = [
    row({ id: "r1", fileIds: ["f1"], docId: "d1", workspaceItemId: "w1" }),
    row({ id: "r2", fileIds: ["stale"], docId: "d2", workspaceItemId: "w1" }),
    row({ id: "r3", fileIds: ["stale"], docId: "d3", workspaceItemId: "w2" }),
    row({ id: "r4", fileIds: ["stale"] }),
  ];
  const plan = hydrationPlan(rows, new Set(["f1"]));
  assert.deepEqual([...plan.keys()], ["w1", "w2"]);
  assert.deepEqual(plan.get("w1"), [{ rowId: "r2", docId: "d2", workspaceItemId: "w1" }]);
  assert.deepEqual(plan.get("w2"), [{ rowId: "r3", docId: "d3", workspaceItemId: "w2" }]);
  assert.deepEqual(orphanRowIds(rows, new Set(["f1"])), ["r4"]);
});

test("a hydrated row whose file id is the doc id is not fetched again", () => {
  const rows = [row({ id: "r1", fileIds: ["d1"], docId: "d1", workspaceItemId: "w1" })];
  assert.equal(hydrationPlan(rows, new Set(["d1"])).size, 0);
});

test("attaching the same workspace twice keeps one entry and never drops ownership", () => {
  const first: ReviewSource = {
    workspaceItemId: "w1",
    kbWorkspaceId: "k1",
    surface: "review",
    name: "A",
    owned: true,
    attachedAt: "2026-01-01T00:00:00.000Z",
  };
  const again = { ...first, name: "A renamed", owned: false };
  const sources = upsertSource(upsertSource([], first), again);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.name, "A renamed");
  assert.equal(sources[0]!.owned, true);
});

test("batch workspace names read well in the Library", () => {
  assert.equal(
    reviewBatchName("Custodian pass", ["smith-depo.pdf"]),
    "Custodian pass · smith-depo",
  );
  assert.equal(
    reviewBatchName("Custodian pass", ["a.pdf", "b.pdf"]),
    "Custodian pass · 2 documents",
  );
  assert.equal(reviewBatchName("   ", ["a.pdf", "b.pdf"]), "Tabular Review · 2 documents");
  assert.ok(reviewBatchName("x".repeat(200), ["a.pdf"]).length <= 120);
});
