import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { documentRowFingerprint } from "./types.ts";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

function section(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return contents.slice(start, end);
}

test("document row fingerprint uses evidence shared by both ingest paths", () => {
  assert.equal(documentRowFingerprint("agreement.pdf", 42), "agreement.pdf|42");
  assert.equal(
    documentRowFingerprint("agreement.pdf", 42),
    documentRowFingerprint("agreement.pdf", 42),
  );
  assert.notEqual(
    documentRowFingerprint("agreement.pdf", 41),
    documentRowFingerprint("agreement.pdf", 42),
  );
});

test("upload and working-set import use the shared fingerprint helper", () => {
  const contents = source("./use-review-table.ts");
  const upload = section(
    contents,
    "const addFiles = useCallback(",
    "const useWorkingSet = useCallback(",
  );
  const uploadCalls =
    upload.match(
      /fingerprint:\s*documentRowFingerprint\(\s*res\.name,\s*pages\.length,\s*await evidenceDigest\(pages\),?\s*\)/g,
    ) ?? [];
  assert.equal(uploadCalls.length, 2);
  assert.doesNotMatch(upload, /fingerprint:\s*`\$\{/);

  const workingSet = section(
    contents,
    "const useWorkingSet = useCallback(",
    "const removeRow = useCallback(",
  );
  assert.match(
    workingSet,
    /documentRowFingerprint\(\s*f\.name,\s*f\.pageCount,\s*await evidenceDigest\(evidence\),?\s*\)/,
  );
});

test("both ingest paths use content-aware matching without name-only fallback", () => {
  const contents = source("./use-review-table.ts");
  const matcher = section(contents, "function findDocumentRow(", "async function requestCell(");
  assert.match(matcher, /sameReviewDocument\(row, fingerprint, docId\)/);
  assert.doesNotMatch(matcher, /row\.label|legacyUploadPrefix/);
});

test("row and column deletion cascade exact owned cells and histories", () => {
  const contents = source("./review.server.ts");
  const cascade = section(contents, "async function deleteCellsAndHistory(", "// --- tables");
  assert.match(cascade, /const p = pk\(principal\)/);
  assert.match(cascade, /queryPrefix\(p,\s*`RHIST#\$\{id\}#`\)/);
  assert.match(cascade, /batchDelete\(historyKeys\)/);
  assert.match(cascade, /batchDelete\(cellKeys\)/);
  assert.ok(
    cascade.indexOf("batchDelete(historyKeys)") < cascade.indexOf("batchDelete(cellKeys)"),
    "history must be deleted before its cell",
  );

  const deleteColumn = section(contents, "export async function deleteColumn(", "// --- rows");
  assert.match(deleteColumn, /tableIdFromChildId\(columnId\)/);
  assert.match(deleteColumn, /queryPrefix\(p,\s*`RCELL#\$\{tableId\}#`\)/);
  assert.match(deleteColumn, /s\(cell\.columnId\) === columnId/);
  assert.ok(
    deleteColumn.indexOf("deleteCellsAndHistory") < deleteColumn.indexOf("deleteItem"),
    "column children must be deleted before the column",
  );

  const deleteRow = section(
    contents,
    "export async function deleteRow(",
    "export async function relinkRow(",
  );
  assert.match(deleteRow, /queryPrefix\(p,\s*`RCELL#\$\{rowId\}~`\)/);
  assert.match(deleteRow, /s\(cell\.rowId\) === rowId/);
  assert.ok(
    deleteRow.indexOf("deleteCellsAndHistory") < deleteRow.indexOf("deleteItem"),
    "row children must be deleted before the row",
  );
});

test("reload statistics exclude cells whose row or column no longer exists", () => {
  const contents = source("./use-review-table.ts");
  const stats = section(contents, "const stats = useMemo(", "/** A row whose document");
  assert.match(stats, /rowIds\.has\(cell\.rowId\) && columnIds\.has\(cell\.columnId\)/);
});
