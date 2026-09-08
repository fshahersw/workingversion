// ============================================================================
// Review-table persistence on DynamoDB (server-only). Replaces the old
// Lovable-Supabase `public.review_*` tables. Everything is owner-scoped: the
// caller passes the Cognito principal (context.user.sub) and keys embed it, so
// a user only ever reaches their own review tables.
//
// Single-table layout on `sw-dev-app` (PK = USER#<principal>):
//   RTBL#<t>                          a review table          (t = ULID)
//   RCOL#<t>#<ulid>                   a column   (id encodes its table)
//   RROW#<t>#<ulid>                   a row      (id encodes its table)
//   RCELL#<t>#<rUlid>~<t>#<cUlid>     a cell     (id = `${rowId}~${columnId}`)
//   RHIST#<cellId>#<ulid>            a cell-history entry
//   RRUN#<t>#<ulid>                   a run
// Child ids embed the table id so an id-only op (deleteColumn, finishRun, …)
// can rebuild its key, and a table's children list by strongly-consistent
// `begins_with` (no GSI, no eventual-consistency gap on the grid).
// ============================================================================
import { ulid } from "ulid";

import { putItem, getItem, queryPrefix, deleteItem, batchDelete } from "@/lib/data/dynamo.server";
import { deleteWorkspace, getWorkspace } from "@/lib/kb/workspace.server";
import type { WorkspaceSurface } from "@/lib/kb/workspace.server";
import { upsertSource } from "./review-sources";
import {
  displayValue,
  type CellCitation,
  type CellStatus,
  type ColumnKind,
  type JsonValue,
  type ReviewCell,
  type ReviewColumn,
  type ReviewRow,
  type ReviewSource,
  type ReviewTable,
} from "./types";

const pk = (p: string) => `USER#${p}`;
const tblSK = (id: string) => `RTBL#${id}`;
const colSK = (id: string) => `RCOL#${id}`;
const rowSK = (id: string) => `RROW#${id}`;
const cellSK = (id: string) => `RCELL#${id}`;
const runSK = (id: string) => `RRUN#${id}`;
const histSK = (cellId: string, id: string) => `RHIST#${cellId}#${id}`;
/** A cell's stable id is derived from its row and column, so re-runs upsert. */
const cellId = (rowId: string, columnId: string) => `${rowId}~${columnId}`;

type Item = Record<string, unknown>;
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" ? v : Number(v ?? d) || d);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// --- mappers -----------------------------------------------------------------

const SOURCE_SURFACES = new Set<WorkspaceSurface>(["workingset", "deposition", "review"]);

function mapSources(raw: unknown): ReviewSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const workspaceItemId = s(o.workspaceItemId);
    const kbWorkspaceId = s(o.kbWorkspaceId);
    const surface = s(o.surface) as WorkspaceSurface;
    if (!workspaceItemId || !kbWorkspaceId || !SOURCE_SURFACES.has(surface)) continue;
    out.push({
      workspaceItemId,
      kbWorkspaceId,
      surface,
      name: s(o.name, "Saved documents"),
      owned: o.owned === true,
      attachedAt: s(o.attachedAt),
    });
  }
  return out;
}

function mapTable(i: Item): ReviewTable {
  return {
    id: s(i.id),
    name: s(i.name, "Untitled review"),
    matterId: (i.matterId as string | null) ?? null,
    matterLabel: (i.matterLabel as string | null) ?? null,
    instructions: (i.instructions as string | null) ?? null,
    createdAt: s(i.createdAt),
    updatedAt: s(i.updatedAt),
    sources: mapSources(i.sources),
  };
}

function mapColumn(i: Item): ReviewColumn {
  return {
    id: s(i.id),
    tableId: s(i.tableId),
    name: s(i.name),
    kind: s(i.kind, "text") as ColumnKind,
    question: s(i.question),
    options: list<string>(i.options).map(String),
    version: n(i.version, 1),
    position: n(i.position, 0),
  };
}

function mapRow(i: Item): ReviewRow {
  return {
    id: s(i.id),
    tableId: s(i.tableId),
    label: s(i.label),
    fileIds: list<string>(i.fileIds).map(String),
    fingerprint: (i.fingerprint as string | null) ?? null,
    pageCount: n(i.pageCount),
    position: n(i.position),
    docId: s(i.docId) || null,
    workspaceItemId: s(i.workspaceItemId) || null,
  };
}

function mapCell(i: Item): ReviewCell {
  return {
    id: s(i.id),
    tableId: s(i.tableId),
    rowId: s(i.rowId),
    columnId: s(i.columnId),
    display: s(i.display),
    value: (i.value ?? null) as JsonValue,
    status: s(i.status, "pending") as CellStatus,
    confidence: (i.confidence as ReviewCell["confidence"]) ?? null,
    citations: list<CellCitation>(i.citations),
    rationale: (i.rationale as string | null) ?? null,
    pagesSearched: list<number>(i.pagesSearched).map(Number),
    error: (i.error as string | null) ?? null,
    overridden: !!i.overridden,
    verifiedAt: (i.verifiedAt as string | null) ?? null,
    cacheKey: (i.cacheKey as string | null) ?? null,
  };
}

function tableIdFromChildId(id: string): string | null {
  const separator = id.indexOf("#");
  return separator > 0 ? id.slice(0, separator) : null;
}

async function deleteCellsAndHistory(principal: string, cells: Item[]): Promise<void> {
  const p = pk(principal);
  const historyKeys: { PK: string; SK: string }[] = [];
  const cellKeys: { PK: string; SK: string }[] = [];

  for (const cell of cells) {
    const id = s(cell.id);
    const sk = s(cell.SK);
    if (!id || !sk) continue;

    const history = await queryPrefix(p, `RHIST#${id}#`);
    for (const entry of history) {
      const historySk = s(entry.SK);
      if (historySk) historyKeys.push({ PK: p, SK: historySk });
    }
    cellKeys.push({ PK: p, SK: sk });
  }

  // History goes first so a failed batch leaves the cell discoverable for an
  // idempotent retry. batchDelete bounds every DynamoDB write to 25 requests.
  if (historyKeys.length) await batchDelete(historyKeys);
  if (cellKeys.length) await batchDelete(cellKeys);
}

// --- tables ------------------------------------------------------------------

export async function listReviewTables(principal: string): Promise<ReviewTable[]> {
  const rows = await queryPrefix(pk(principal), "RTBL#");
  return rows
    .map(mapTable)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 50);
}

export async function createReviewTable(
  principal: string,
  input: { name: string; matterId?: string | null; matterLabel?: string | null; instructions?: string | null },
): Promise<ReviewTable> {
  const id = ulid();
  const now = new Date().toISOString();
  await putItem({
    PK: pk(principal),
    SK: tblSK(id),
    entity: "rtable",
    owner: principal,
    id,
    name: input.name.trim() || "Untitled review",
    matterId: input.matterId ?? null,
    matterLabel: input.matterLabel ?? null,
    instructions: input.instructions ?? null,
    sources: [],
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    name: input.name.trim() || "Untitled review",
    matterId: input.matterId ?? null,
    matterLabel: input.matterLabel ?? null,
    instructions: input.instructions ?? null,
    createdAt: now,
    updatedAt: now,
    sources: [],
  };
}

/**
 * Attach a saved workspace as a document source. The workspace must exist
 * and belong to the caller; its identity is read from the record, never from
 * the browser, so a table can only ever reference the owner's own documents.
 */
export async function attachReviewSource(
  principal: string,
  input: { tableId: string; workspaceItemId: string; owned: boolean },
): Promise<ReviewSource[]> {
  const tableItem = await getItem(pk(principal), tblSK(input.tableId), { consistent: true });
  if (!tableItem) throw new Error("Table not found");
  const workspace = await getWorkspace(principal, input.workspaceItemId);
  if (!workspace) throw new Error("Saved documents were not found");
  const source: ReviewSource = {
    workspaceItemId: workspace.itemId,
    kbWorkspaceId: workspace.kbWorkspaceId,
    surface: workspace.surface,
    name: workspace.name,
    owned: input.owned,
    attachedAt: new Date().toISOString(),
  };
  const sources = upsertSource(mapSources(tableItem.sources), source);
  await putItem({ ...tableItem, sources, updatedAt: new Date().toISOString() });
  return sources;
}

/**
 * Bind rows to KB documents once their source workspace has indexed them.
 * Every docId is checked against the workspace's own document list; a row
 * that is already bound keeps its binding.
 */
export async function bindRowDocuments(
  principal: string,
  input: { tableId: string; workspaceItemId: string; bindings: { rowId: string; docId: string }[] },
): Promise<ReviewRow[]> {
  if (!input.bindings.length) return [];
  const workspace = await getWorkspace(principal, input.workspaceItemId);
  if (!workspace) throw new Error("Saved documents were not found");
  const known = new Set(workspace.docs.map((doc) => doc.docId));
  const out: ReviewRow[] = [];
  for (const binding of input.bindings) {
    if (!known.has(binding.docId)) continue;
    if (tableIdFromChildId(binding.rowId) !== input.tableId) continue;
    const item = await getItem(pk(principal), rowSK(binding.rowId));
    if (!item || s(item.tableId) !== input.tableId) continue;
    if (s(item.docId)) {
      out.push(mapRow(item));
      continue;
    }
    const next = { ...item, docId: binding.docId, workspaceItemId: workspace.itemId };
    await putItem(next);
    out.push(mapRow(next));
  }
  return out;
}

async function touchTable(principal: string, tableId: string): Promise<void> {
  const t = await getItem(pk(principal), tblSK(tableId));
  if (!t) return;
  await putItem({ ...t, updatedAt: new Date().toISOString() });
}

export async function renameReviewTable(principal: string, id: string, name: string): Promise<void> {
  const t = await getItem(pk(principal), tblSK(id));
  if (!t) return;
  await putItem({ ...t, name: name.trim() || "Untitled review", updatedAt: new Date().toISOString() });
}

export async function deleteReviewTable(principal: string, id: string): Promise<void> {
  const p = pk(principal);
  // Saved document workspaces this table created go first. A failure leaves
  // the table in place so the user can retry rather than orphan storage.
  const tableItem = await getItem(p, tblSK(id), { consistent: true });
  if (tableItem) {
    const owned = mapSources(tableItem.sources).filter((source) => source.owned);
    for (const source of owned) {
      const result = await deleteWorkspace(principal, source.workspaceItemId);
      if (!result.ok) {
        throw new Error("Saved documents for this table could not be deleted. Try again.");
      }
    }
  }
  // Cascade: every child SK is prefixed with the table id.
  for (const prefix of ["RCOL#", "RROW#", "RCELL#", "RRUN#", "RHIST#"]) {
    const kids = await queryPrefix(p, `${prefix}${id}#`);
    if (kids.length) {
      await batchDelete(kids.map((k) => ({ PK: k.PK as string, SK: k.SK as string })));
    }
  }
  await deleteItem(p, tblSK(id));
}

// --- columns -----------------------------------------------------------------

export async function listColumns(principal: string, tableId: string): Promise<ReviewColumn[]> {
  const rows = await queryPrefix(pk(principal), `RCOL#${tableId}#`);
  return rows.map(mapColumn).sort((a, b) => a.position - b.position);
}

export async function createColumn(
  principal: string,
  input: { tableId: string; name: string; kind: ColumnKind; question: string; options: string[]; position: number },
): Promise<ReviewColumn> {
  const id = `${input.tableId}#${ulid()}`;
  const col: ReviewColumn = {
    id,
    tableId: input.tableId,
    name: input.name.trim() || "Untitled column",
    kind: input.kind,
    question: input.question.trim(),
    options: input.options,
    version: 1,
    position: input.position,
  };
  await putItem({ PK: pk(principal), SK: colSK(id), entity: "rcolumn", owner: principal, ...col, createdAt: new Date().toISOString() });
  return col;
}

export async function updateColumn(
  principal: string,
  columnId: string,
  patch: { name?: string; kind?: ColumnKind; question?: string; options?: string[] },
): Promise<ReviewColumn> {
  const item = await getItem(pk(principal), colSK(columnId));
  if (!item) throw new Error("Column not found");
  const current = mapColumn(item);
  // A prompt / type / options change bumps the version, invalidating this
  // column's cell cache keys so only this column recomputes on the next run.
  const semantic =
    (patch.question !== undefined && patch.question.trim() !== current.question) ||
    (patch.kind !== undefined && patch.kind !== current.kind) ||
    (patch.options !== undefined &&
      patch.options.join("\u0000") !== current.options.join("\u0000"));
  const next: ReviewColumn = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.question !== undefined ? { question: patch.question.trim() } : {}),
    ...(patch.options !== undefined ? { options: patch.options } : {}),
    version: semantic ? current.version + 1 : current.version,
  };
  await putItem({ ...item, ...next });
  return next;
}

export async function deleteColumn(principal: string, columnId: string): Promise<void> {
  const p = pk(principal);
  const tableId = tableIdFromChildId(columnId);
  if (tableId) {
    const candidates = await queryPrefix(p, `RCELL#${tableId}#`);
    const cells = candidates.filter((cell) => s(cell.columnId) === columnId);
    await deleteCellsAndHistory(principal, cells);
  }
  await deleteItem(p, colSK(columnId));
}

// --- rows --------------------------------------------------------------------

export async function listRows(principal: string, tableId: string): Promise<ReviewRow[]> {
  const rows = await queryPrefix(pk(principal), `RROW#${tableId}#`);
  return rows.map(mapRow).sort((a, b) => a.position - b.position);
}

export type RowInsert = {
  label: string;
  fileIds: string[];
  fingerprint: string;
  pageCount: number;
  /** Present when the document is already indexed in a saved workspace. */
  docId?: string | null;
  workspaceItemId?: string | null;
};

export async function upsertRows(
  principal: string,
  tableId: string,
  rows: RowInsert[],
  startPosition: number,
): Promise<ReviewRow[]> {
  const out: ReviewRow[] = [];
  const now = new Date().toISOString();
  // Bindings supplied at insert time are verified against the workspace's own
  // document list, exactly like a later bind.
  const knownByWorkspace = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.docId || !r.workspaceItemId || knownByWorkspace.has(r.workspaceItemId)) continue;
    const workspace = await getWorkspace(principal, r.workspaceItemId);
    knownByWorkspace.set(
      r.workspaceItemId,
      new Set(workspace ? workspace.docs.map((doc) => doc.docId) : []),
    );
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const id = `${tableId}#${ulid()}`;
    const bound =
      !!r.docId && !!r.workspaceItemId && knownByWorkspace.get(r.workspaceItemId)?.has(r.docId);
    const row: ReviewRow = {
      id,
      tableId,
      label: r.label.slice(0, 300),
      fileIds: r.fileIds,
      fingerprint: r.fingerprint,
      pageCount: r.pageCount,
      position: startPosition + i,
      docId: bound ? r.docId! : null,
      workspaceItemId: bound ? r.workspaceItemId! : null,
    };
    await putItem({ PK: pk(principal), SK: rowSK(id), entity: "rrow", owner: principal, ...row, createdAt: now });
    out.push(row);
  }
  return out;
}

export async function deleteRow(principal: string, rowId: string): Promise<void> {
  const p = pk(principal);
  const candidates = await queryPrefix(p, `RCELL#${rowId}~`);
  const cells = candidates.filter((cell) => s(cell.rowId) === rowId);
  await deleteCellsAndHistory(principal, cells);
  await deleteItem(p, rowSK(rowId));
}

export async function relinkRow(principal: string, rowId: string, fileIds: string[]): Promise<void> {
  const item = await getItem(pk(principal), rowSK(rowId));
  if (!item) return;
  await putItem({ ...item, fileIds });
}

// --- cells -------------------------------------------------------------------

export async function listCells(principal: string, tableId: string): Promise<ReviewCell[]> {
  const rows = await queryPrefix(pk(principal), `RCELL#${tableId}#`);
  return rows.map(mapCell);
}

export type CellWrite = {
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

export async function saveCells(principal: string, cells: CellWrite[]): Promise<ReviewCell[]> {
  const out: ReviewCell[] = [];
  for (const c of cells) {
    const id = cellId(c.rowId, c.columnId);
    const cell: ReviewCell = {
      id,
      tableId: c.tableId,
      rowId: c.rowId,
      columnId: c.columnId,
      display: c.display,
      value: c.value ?? null,
      status: c.status,
      confidence: (c.confidence as ReviewCell["confidence"]) ?? null,
      citations: c.citations,
      rationale: c.rationale,
      pagesSearched: c.pagesSearched,
      error: c.error,
      overridden: false,
      verifiedAt: null,
      cacheKey: c.cacheKey,
    };
    await putItem({
      PK: pk(principal),
      SK: cellSK(id),
      entity: "rcell",
      owner: principal,
      ...cell,
      runId: c.runId ?? null,
      updatedAt: new Date().toISOString(),
    });
    out.push(cell);
  }
  return out;
}

async function logCell(
  principal: string,
  cell: ReviewCell,
  action: string,
  prev: string | null,
  next: string | null,
  actorEmail: string | null,
): Promise<void> {
  const id = ulid();
  await putItem({
    PK: pk(principal),
    SK: histSK(cell.id, id),
    entity: "rhist",
    owner: principal,
    id,
    cellId: cell.id,
    action,
    previousDisplay: prev,
    nextDisplay: next,
    actorEmail,
    createdAt: new Date().toISOString(),
  });
}

export async function overrideCell(
  principal: string,
  cell: ReviewCell,
  value: string,
  actorEmail: string | null,
): Promise<ReviewCell> {
  const display = displayValue(value);
  const updated: ReviewCell = {
    ...cell,
    value,
    display,
    status: value.trim() ? "answered" : "not_found",
    overridden: true,
    verifiedAt: new Date().toISOString(),
    error: null,
  };
  await putItem({ PK: pk(principal), SK: cellSK(cell.id), entity: "rcell", owner: principal, ...updated, updatedAt: new Date().toISOString() });
  await logCell(principal, cell, "override", cell.display, display, actorEmail);
  return updated;
}

export async function setCellVerified(
  principal: string,
  cell: ReviewCell,
  verified: boolean,
  actorEmail: string | null,
): Promise<ReviewCell> {
  const updated: ReviewCell = { ...cell, verifiedAt: verified ? new Date().toISOString() : null };
  await putItem({ PK: pk(principal), SK: cellSK(cell.id), entity: "rcell", owner: principal, ...updated, updatedAt: new Date().toISOString() });
  await logCell(principal, cell, verified ? "verify" : "unverify", cell.display, cell.display, actorEmail);
  return updated;
}

// --- history -----------------------------------------------------------------

export type CellHistoryEntry = {
  id: string;
  action: string;
  previousDisplay: string | null;
  nextDisplay: string | null;
  actorEmail: string | null;
  createdAt: string;
};

export async function listCellHistory(principal: string, cellId2: string): Promise<CellHistoryEntry[]> {
  const rows = await queryPrefix(pk(principal), `RHIST#${cellId2}#`, { scanForward: false, limit: 20 });
  return rows.map((r) => ({
    id: s(r.id),
    action: s(r.action),
    previousDisplay: (r.previousDisplay as string | null) ?? null,
    nextDisplay: (r.nextDisplay as string | null) ?? null,
    actorEmail: (r.actorEmail as string | null) ?? null,
    createdAt: s(r.createdAt),
  }));
}

// --- runs --------------------------------------------------------------------

export async function startRun(
  principal: string,
  input: { tableId: string; columnIds: string[]; snapshot: Record<string, unknown>; cellsTotal: number },
): Promise<string | null> {
  try {
    const id = `${input.tableId}#${ulid()}`;
    await putItem({
      PK: pk(principal),
      SK: runSK(id),
      entity: "rrun",
      owner: principal,
      id,
      tableId: input.tableId,
      columnIds: input.columnIds,
      snapshot: input.snapshot,
      cellsTotal: input.cellsTotal,
      cellsDone: 0,
      cellsFailed: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    await touchTable(principal, input.tableId);
    return id;
  } catch {
    return null;
  }
}

export async function finishRun(
  principal: string,
  runId: string | null,
  counts: { done: number; failed: number; status: "complete" | "cancelled" | "failed" },
): Promise<void> {
  if (!runId) return;
  const item = await getItem(pk(principal), runSK(runId));
  if (!item) return;
  await putItem({
    ...item,
    cellsDone: counts.done,
    cellsFailed: counts.failed,
    status: counts.status,
    finishedAt: new Date().toISOString(),
  });
}

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

export async function latestRun(principal: string, tableId: string): Promise<RunSummary | null> {
  const rows = await queryPrefix(pk(principal), `RRUN#${tableId}#`, { scanForward: false, limit: 1 });
  const r = rows[0];
  if (!r) return null;
  return {
    id: s(r.id),
    status: s(r.status),
    cellsTotal: n(r.cellsTotal),
    cellsDone: n(r.cellsDone),
    cellsFailed: n(r.cellsFailed),
    startedAt: s(r.startedAt),
    finishedAt: (r.finishedAt as string | null) ?? null,
    snapshot: (r.snapshot as Record<string, JsonValue>) ?? {},
  };
}
