// Client-callable server functions for review-table persistence, gated by
// requireAuth and scoped to the authenticated Cognito principal. Replaces the
// old browser-side Supabase calls in review-db.ts.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import { isUuid } from "@/lib/kb/workspace-lifecycle";
import type { CellWrite, RowInsert } from "@/lib/review/review.server";
import type { CellStatus, ColumnKind, ReviewCell } from "@/lib/review/types";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const MAX_ROWS_PER_CALL = 200;
const ID = /^[A-Za-z0-9#~_.:-]{1,200}$/;

function requireId(value: unknown, label: string): string {
  const id = String(value ?? "").trim();
  if (!ID.test(id)) throw new Error(`${label} required`);
  return id;
}

function requireWorkspaceItemId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!isUuid(id)) throw new Error("valid workspaceItemId required");
  return id;
}

function cleanRowInsert(raw: unknown): RowInsert {
  const r = (raw ?? {}) as Record<string, unknown>;
  const label = String(r.label ?? "").trim();
  if (!label) throw new Error("row label required");
  const fileIds = Array.isArray(r.fileIds) ? r.fileIds.map(String).filter(Boolean).slice(0, 8) : [];
  const pageCount = Number(r.pageCount);
  const docId = r.docId ? String(r.docId).trim() : null;
  const workspaceItemId = r.workspaceItemId ? String(r.workspaceItemId).trim() : null;
  if ((docId && !workspaceItemId) || (!docId && workspaceItemId)) {
    throw new Error("docId and workspaceItemId must be supplied together");
  }
  if (workspaceItemId && !isUuid(workspaceItemId)) throw new Error("valid workspaceItemId required");
  if (docId && !ID.test(docId)) throw new Error("valid docId required");
  return {
    label,
    fileIds,
    fingerprint: String(r.fingerprint ?? ""),
    pageCount: Number.isFinite(pageCount) && pageCount >= 0 ? Math.floor(pageCount) : 0,
    docId,
    workspaceItemId,
  };
}

export const listReviewTablesFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const m = await import("@/lib/review/review.server");
    return m.listReviewTables(principalOf(context));
  });

export const createReviewTableFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { name: string; matterId?: string | null; matterLabel?: string | null; instructions?: string | null }) => ({
    name: d?.name ?? "Untitled review",
    matterId: d?.matterId ?? null,
    matterLabel: d?.matterLabel ?? null,
    instructions: d?.instructions ?? null,
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.createReviewTable(principalOf(context), data);
  });

export const renameReviewTableFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { id: string; name: string }) => {
    if (!d?.id) throw new Error("id required");
    return { id: d.id, name: d.name ?? "" };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.renameReviewTable(principalOf(context), data.id, data.name);
    return { ok: true };
  });

export const deleteReviewTableFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { id: string }) => {
    if (!d?.id) throw new Error("id required");
    return { id: d.id };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.deleteReviewTable(principalOf(context), data.id);
    return { ok: true };
  });

export const listColumnsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return { tableId: d.tableId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.listColumns(principalOf(context), data.tableId);
  });

export const createColumnFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string; name: string; kind: ColumnKind; question: string; options: string[]; position: number }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return {
      tableId: d.tableId,
      name: d.name ?? "",
      kind: d.kind,
      question: d.question ?? "",
      options: Array.isArray(d.options) ? d.options : [],
      position: Number(d.position) || 0,
    };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.createColumn(principalOf(context), data);
  });

export const updateColumnFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { columnId: string; patch: { name?: string; kind?: ColumnKind; question?: string; options?: string[] } }) => {
    if (!d?.columnId) throw new Error("columnId required");
    return { columnId: d.columnId, patch: d.patch ?? {} };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.updateColumn(principalOf(context), data.columnId, data.patch);
  });

export const deleteColumnFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { columnId: string }) => {
    if (!d?.columnId) throw new Error("columnId required");
    return { columnId: d.columnId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.deleteColumn(principalOf(context), data.columnId);
    return { ok: true };
  });

export const listRowsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return { tableId: d.tableId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.listRows(principalOf(context), data.tableId);
  });

export const upsertRowsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string; rows: RowInsert[]; startPosition: number }) => {
    const tableId = requireId(d?.tableId, "tableId");
    const rows = Array.isArray(d?.rows) ? d.rows : [];
    if (rows.length > MAX_ROWS_PER_CALL) throw new Error("too many rows in one call");
    return { tableId, rows: rows.map(cleanRowInsert), startPosition: Number(d.startPosition) || 0 };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.upsertRows(principalOf(context), data.tableId, data.rows, data.startPosition);
  });

/** Reference a saved workspace's documents from a table (ownership verified server-side). */
export const attachReviewSourceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string; workspaceItemId: string; owned: boolean }) => ({
    tableId: requireId(d?.tableId, "tableId"),
    workspaceItemId: requireWorkspaceItemId(d?.workspaceItemId),
    owned: d?.owned === true,
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.attachReviewSource(principalOf(context), data);
  });

/** Bind rows to the KB documents a finished save produced. */
export const bindRowDocumentsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { tableId: string; workspaceItemId: string; bindings: { rowId: string; docId: string }[] }) => {
      const bindings = Array.isArray(d?.bindings) ? d.bindings : [];
      if (bindings.length > MAX_ROWS_PER_CALL) throw new Error("too many bindings in one call");
      return {
        tableId: requireId(d?.tableId, "tableId"),
        workspaceItemId: requireWorkspaceItemId(d?.workspaceItemId),
        bindings: bindings.map((b) => ({
          rowId: requireId(b?.rowId, "rowId"),
          docId: requireId(b?.docId, "docId"),
        })),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.bindRowDocuments(principalOf(context), data);
  });

export const deleteRowFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { rowId: string }) => {
    if (!d?.rowId) throw new Error("rowId required");
    return { rowId: d.rowId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.deleteRow(principalOf(context), data.rowId);
    return { ok: true };
  });

export const relinkRowFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { rowId: string; fileIds: string[] }) => {
    if (!d?.rowId) throw new Error("rowId required");
    return { rowId: d.rowId, fileIds: Array.isArray(d.fileIds) ? d.fileIds : [] };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.relinkRow(principalOf(context), data.rowId, data.fileIds);
    return { ok: true };
  });

export const listCellsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return { tableId: d.tableId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.listCells(principalOf(context), data.tableId);
  });

export const saveCellsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { cells: CellWrite[] }) => ({ cells: Array.isArray(d?.cells) ? d.cells : [] }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.saveCells(principalOf(context), data.cells);
  });

export const overrideCellFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { cell: ReviewCell; value: string; actorEmail: string | null }) => {
    if (!d?.cell?.id) throw new Error("cell required");
    return { cell: d.cell, value: d.value ?? "", actorEmail: d.actorEmail ?? null };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.overrideCell(principalOf(context), data.cell, data.value, data.actorEmail);
  });

export const setCellVerifiedFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { cell: ReviewCell; verified: boolean; actorEmail: string | null }) => {
    if (!d?.cell?.id) throw new Error("cell required");
    return { cell: d.cell, verified: !!d.verified, actorEmail: d.actorEmail ?? null };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.setCellVerified(principalOf(context), data.cell, data.verified, data.actorEmail);
  });

export const listCellHistoryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { cellId: string }) => {
    if (!d?.cellId) throw new Error("cellId required");
    return { cellId: d.cellId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.listCellHistory(principalOf(context), data.cellId);
  });

export const startRunFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string; columnIds: string[]; snapshot: Record<string, unknown>; cellsTotal: number }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return {
      tableId: d.tableId,
      columnIds: Array.isArray(d.columnIds) ? d.columnIds : [],
      snapshot: d.snapshot ?? {},
      cellsTotal: Number(d.cellsTotal) || 0,
    };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.startRun(principalOf(context), data);
  });

export const finishRunFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { runId: string | null; counts: { done: number; failed: number; status: "complete" | "cancelled" | "failed" } }) => ({
    runId: d?.runId ?? null,
    counts: d?.counts ?? { done: 0, failed: 0, status: "complete" as const },
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    await m.finishRun(principalOf(context), data.runId, data.counts);
    return { ok: true };
  });

export const latestRunFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { tableId: string }) => {
    if (!d?.tableId) throw new Error("tableId required");
    return { tableId: d.tableId };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/review/review.server");
    return m.latestRun(principalOf(context), data.tableId);
  });
