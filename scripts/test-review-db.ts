// Integration test of the review-table DynamoDB layer against live sw-dev-app
// (bypasses the server-fn/auth layer; throwaway test principal).
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-review-db.ts
import {
  createReviewTable,
  renameReviewTable,
  listReviewTables,
  createColumn,
  updateColumn,
  listColumns,
  upsertRows,
  listRows,
  saveCells,
  listCells,
  overrideCell,
  setCellVerified,
  listCellHistory,
  startRun,
  finishRun,
  latestRun,
  deleteReviewTable,
} from "../src/lib/review/review.server";

const P = `test-principal-${Date.now()}`;

async function main() {
  const t = await createReviewTable(P, { name: "AFFF custodian pass" });
  console.log("table:", t.id, "|", t.name);

  await renameReviewTable(P, t.id, "AFFF custodian — privilege");
  const tables = await listReviewTables(P);
  console.log("listTables:", tables.length, "| renamed:", tables.find((x) => x.id === t.id)?.name);

  const col = await createColumn(P, { tableId: t.id, name: "Privileged?", kind: "yes_no", question: "Is this privileged?", options: [], position: 0 });
  console.log("column:", col.id, "| v", col.version, "| id encodes table:", col.id.startsWith(t.id + "#"));

  const bumped = await updateColumn(P, col.id, { question: "Is this attorney-client privileged?" });
  console.log("updateColumn version bump:", col.version, "->", bumped.version, "(want 2)");

  const [r1] = await upsertRows(P, t.id, [{ label: "DOC_0001.pdf", fileIds: ["f1"], fingerprint: "fp1", pageCount: 3 }], 0);
  console.log("row:", r1!.id, "| id encodes table:", r1!.id.startsWith(t.id + "#"));

  const [cell] = await saveCells(P, [{
    tableId: t.id, rowId: r1!.id, columnId: col.id,
    value: "Yes", display: "Yes", status: "answered", confidence: "high",
    citations: [{ page: 2, quote: "attorney work product" }], rationale: "header", pagesSearched: [1, 2, 3],
    error: null, cacheKey: "ck1", runId: null,
  }]);
  console.log("cell:", cell!.id, "| status:", cell!.status, "| value:", cell!.value);

  const cols = await listColumns(P, t.id);
  const rows = await listRows(P, t.id);
  const cells = await listCells(P, t.id);
  console.log("lists -> cols:", cols.length, "rows:", rows.length, "cells:", cells.length);

  const overridden = await overrideCell(P, cell!, "No", "fshaher@seegerweiss.com");
  console.log("override -> status:", overridden.status, "overridden:", overridden.overridden);
  await setCellVerified(P, overridden, true, "fshaher@seegerweiss.com");
  const hist = await listCellHistory(P, cell!.id);
  console.log("history entries:", hist.length, "| actions:", hist.map((h) => h.action).join(","));

  const runId = await startRun(P, { tableId: t.id, columnIds: [col.id], snapshot: { note: "test" }, cellsTotal: 1 });
  await finishRun(P, runId, { done: 1, failed: 0, status: "complete" });
  const run = await latestRun(P, t.id);
  console.log("run:", run?.status, "| done:", run?.cellsDone);

  await deleteReviewTable(P, t.id);
  const afterCols = await listColumns(P, t.id);
  const afterCells = await listCells(P, t.id);
  const afterTables = (await listReviewTables(P)).filter((x) => x.id === t.id);
  console.log("after delete -> cols:", afterCols.length, "cells:", afterCells.length, "tables:", afterTables.length, "(all want 0)");

  if (bumped.version !== 2 || overridden.status !== "answered" || hist.length < 2 || run?.status !== "complete" ||
      afterCols.length || afterCells.length || afterTables.length) {
    throw new Error("assertion failed");
  }
  console.log("\nREVIEW-DB TEST PASSED for principal", P);
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
