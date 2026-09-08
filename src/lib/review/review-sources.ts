// ============================================================================
// Tabular Review — pure helpers for binding rows to saved KB documents.
//
// No network, no React, no `@/` imports: runs under the Node test runner. The
// hook composes these into save → bind → hydrate; the server validates the
// same shapes before writing them.
// ============================================================================
import type { ReviewRow, ReviewSource } from "./types.ts";

export type RowBinding = { rowId: string; docId: string; workspaceItemId: string };

/**
 * Rows whose live browser file id resolved to a KB document once a save
 * finished. Rows already bound elsewhere are left alone: a document belongs
 * to the first workspace that indexed it.
 */
export function bindingsFromSave(
  rows: readonly ReviewRow[],
  workspaceItemId: string,
  docIdByFileId: Readonly<Record<string, string>>,
): RowBinding[] {
  const out: RowBinding[] = [];
  for (const row of rows) {
    if (row.docId) continue;
    const fileId = row.fileIds.find((id) => docIdByFileId[id]);
    if (!fileId) continue;
    out.push({ rowId: row.id, docId: docIdByFileId[fileId]!, workspaceItemId });
  }
  return out;
}

/**
 * Rows that must have their pages fetched from storage before this session
 * can run or cite them: bound to a saved document, but none of their file ids
 * is live in the pile. Grouped by workspace so each is fetched once.
 */
export function hydrationPlan(
  rows: readonly ReviewRow[],
  liveFileIds: ReadonlySet<string>,
): Map<string, RowBinding[]> {
  const plan = new Map<string, RowBinding[]>();
  for (const row of rows) {
    if (!row.docId || !row.workspaceItemId) continue;
    if (row.fileIds.some((id) => liveFileIds.has(id))) continue;
    const list = plan.get(row.workspaceItemId) ?? [];
    list.push({ rowId: row.id, docId: row.docId, workspaceItemId: row.workspaceItemId });
    plan.set(row.workspaceItemId, list);
  }
  return plan;
}

/** Rows that can never be rehydrated: no saved document and no live file. */
export function orphanRowIds(
  rows: readonly ReviewRow[],
  liveFileIds: ReadonlySet<string>,
): string[] {
  return rows
    .filter((row) => !row.docId && !row.fileIds.some((id) => liveFileIds.has(id)))
    .map((row) => row.id);
}

/** Replace-or-append by workspace id; order is attach order. */
export function upsertSource(sources: readonly ReviewSource[], next: ReviewSource): ReviewSource[] {
  const index = sources.findIndex((s) => s.workspaceItemId === next.workspaceItemId);
  if (index < 0) return [...sources, next];
  const out = sources.slice();
  out[index] = { ...sources[index]!, ...next, owned: sources[index]!.owned || next.owned };
  return out;
}

/** Library-visible name for the workspace a drop batch is saved as. */
export function reviewBatchName(tableName: string, fileNames: readonly string[]): string {
  const table = tableName.trim() || "Tabular Review";
  const count = fileNames.length;
  const detail =
    count === 1
      ? fileNames[0]!.replace(/\.[^.]+$/, "")
      : `${count} document${count === 1 ? "" : "s"}`;
  return `${table} · ${detail}`.slice(0, 120);
}
