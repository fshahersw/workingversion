// ============================================================================
// Durable review-table state. Owner-scoped rows on DynamoDB (`sw-dev-app`),
// reached through server functions (review.functions.ts) so the owner is the
// authenticated Cognito principal, derived server-side — never trusted from the
// browser. Was Lovable Supabase (`public.review_*`); same exported surface, so
// use-review-table / CellDrawer / ReviewTablesTab are unchanged.
//
// Documents are saved as KB workspaces the table references (`sources`), and
// rows bind to their KB document, so a reopened table rehydrates from storage.
// Citations still store their verbatim quote so a cell reads on its own.
// ============================================================================
import {
  attachReviewSourceFn,
  bindRowDocumentsFn,
  createColumnFn,
  createReviewTableFn,
  deleteColumnFn,
  deleteReviewTableFn,
  deleteRowFn,
  finishRunFn,
  latestRunFn,
  listCellHistoryFn,
  listCellsFn,
  listColumnsFn,
  listReviewTablesFn,
  listRowsFn,
  overrideCellFn,
  relinkRowFn,
  renameReviewTableFn,
  saveCellsFn,
  setCellVerifiedFn,
  startRunFn,
  updateColumnFn,
  upsertRowsFn,
} from "@/lib/review/review.functions";
import type {
  CellCitation,
  CellStatus,
  ColumnKind,
  JsonValue,
  ReviewCell,
  ReviewColumn,
  ReviewRow,
  ReviewSource,
  ReviewTable,
} from "./types";

export type RowInsert = {
  label: string;
  fileIds: string[];
  fingerprint: string;
  pageCount: number;
  docId?: string | null;
  workspaceItemId?: string | null;
};

export type CellHistoryEntry = {
  id: string;
  action: string;
  previousDisplay: string | null;
  nextDisplay: string | null;
  actorEmail: string | null;
  createdAt: string;
};

export type RunSummary = {
  id: string;
  status: string;
  cellsTotal: number;
  cellsDone: number;
  cellsFailed: number;
  startedAt: string;
  finishedAt: string | null;
  snapshot: Record<string, JsonValue>;
};

/** owner is accepted for call-site compatibility but ignored — the server uses
 *  the Cognito session principal. */
export type CellWrite = {
  owner: string;
  tableId: string;
  rowId: string;
  columnId: string;
  value: JsonValue;
  display: string;
  status: CellStatus;
  confidence: string | null;
  citations: CellCitation[];
  rationale: string | null;
  pagesSearched: number[];
  error: string | null;
  cacheKey: string | null;
  runId?: string | null;
};

// --- tables ------------------------------------------------------------------

export async function listReviewTables(): Promise<ReviewTable[]> {
  return listReviewTablesFn();
}

export async function createReviewTable(input: {
  owner: string;
  name: string;
  matterId?: string | null;
  matterLabel?: string | null;
  instructions?: string | null;
}): Promise<ReviewTable> {
  return createReviewTableFn({
    data: {
      name: input.name,
      matterId: input.matterId ?? null,
      matterLabel: input.matterLabel ?? null,
      instructions: input.instructions ?? null,
    },
  });
}

export async function renameReviewTable(id: string, name: string): Promise<void> {
  await renameReviewTableFn({ data: { id, name } });
}

export async function deleteReviewTable(id: string): Promise<void> {
  await deleteReviewTableFn({ data: { id } });
}

// --- columns -----------------------------------------------------------------

export async function listColumns(tableId: string): Promise<ReviewColumn[]> {
  return listColumnsFn({ data: { tableId } });
}

export async function createColumn(input: {
  owner: string;
  tableId: string;
  name: string;
  kind: ColumnKind;
  question: string;
  options: string[];
  position: number;
}): Promise<ReviewColumn> {
  return createColumnFn({
    data: {
      tableId: input.tableId,
      name: input.name,
      kind: input.kind,
      question: input.question,
      options: input.options,
      position: input.position,
    },
  });
}

export async function updateColumn(
  column: ReviewColumn,
  patch: { name?: string; kind?: ColumnKind; question?: string; options?: string[] },
): Promise<ReviewColumn> {
  return updateColumnFn({ data: { columnId: column.id, patch } });
}

export async function deleteColumn(id: string): Promise<void> {
  await deleteColumnFn({ data: { columnId: id } });
}

// --- rows --------------------------------------------------------------------

export async function listRows(tableId: string): Promise<ReviewRow[]> {
  return listRowsFn({ data: { tableId } });
}

export async function upsertRows(
  _owner: string,
  tableId: string,
  rows: RowInsert[],
  startPosition: number,
): Promise<ReviewRow[]> {
  if (!rows.length) return [];
  return upsertRowsFn({ data: { tableId, rows, startPosition } });
}

// --- saved document sources --------------------------------------------------

export async function attachSource(
  tableId: string,
  workspaceItemId: string,
  owned: boolean,
): Promise<ReviewSource[]> {
  return attachReviewSourceFn({ data: { tableId, workspaceItemId, owned } });
}

export async function bindRowDocuments(
  tableId: string,
  workspaceItemId: string,
  bindings: { rowId: string; docId: string }[],
): Promise<ReviewRow[]> {
  if (!bindings.length) return [];
  return bindRowDocumentsFn({ data: { tableId, workspaceItemId, bindings } });
}

export async function deleteRow(id: string): Promise<void> {
  await deleteRowFn({ data: { rowId: id } });
}

export async function relinkRow(id: string, fileIds: string[]): Promise<void> {
  await relinkRowFn({ data: { rowId: id, fileIds } });
}

// --- cells -------------------------------------------------------------------

export async function listCells(tableId: string): Promise<ReviewCell[]> {
  return listCellsFn({ data: { tableId } });
}

export async function saveCells(cells: CellWrite[]): Promise<ReviewCell[]> {
  if (!cells.length) return [];
  const stripped = cells.map(({ owner: _owner, ...rest }) => rest);
  return saveCellsFn({ data: { cells: stripped } });
}

export async function overrideCell(
  cell: ReviewCell,
  value: string,
  actorEmail: string | null,
): Promise<ReviewCell> {
  return overrideCellFn({ data: { cell, value, actorEmail } });
}

export async function setCellVerified(
  cell: ReviewCell,
  verified: boolean,
  actorEmail: string | null,
): Promise<ReviewCell> {
  return setCellVerifiedFn({ data: { cell, verified, actorEmail } });
}

// --- history -----------------------------------------------------------------

export async function listCellHistory(cellId: string): Promise<CellHistoryEntry[]> {
  return listCellHistoryFn({ data: { cellId } });
}

// --- runs --------------------------------------------------------------------

export async function startRun(input: {
  owner: string;
  tableId: string;
  columnIds: string[];
  snapshot: Record<string, unknown>;
  cellsTotal: number;
}): Promise<string | null> {
  return startRunFn({
    data: {
      tableId: input.tableId,
      columnIds: input.columnIds,
      snapshot: input.snapshot,
      cellsTotal: input.cellsTotal,
    },
  });
}

export async function finishRun(
  runId: string | null,
  counts: { done: number; failed: number; status: "complete" | "cancelled" | "failed" },
): Promise<void> {
  await finishRunFn({ data: { runId, counts } });
}

export async function latestRun(tableId: string): Promise<RunSummary | null> {
  return latestRunFn({ data: { tableId } });
}
