// ============================================================================
// Sheets run snapshot (pure): what to capture before an agent batch applies,
// how much is safe to hold, and how to restore it.
//
// The native undo stack cannot be the rollback mechanism for agent runs: a
// large committed batch (fill_range over 80k rows, finish_table, a big
// set_range) is dropped from undo history to keep the editor responsive, so
// ⌘Z — and the chat [Undo] built on it — silently does nothing. Instead the
// apply path captures the PRIOR cell data of every block a batch is about to
// write (values, formulas, styles), plus column widths, row heights, merges
// and sheet names it changes, into one snapshot for the whole run. Rollback
// writes those blocks back, newest first. Bounded: past RUN_SNAPSHOT_MAX_CELLS
// the snapshot is marked truncated and rollback is refused with a reason
// instead of half-reverting.
//
// Limits stated, not hidden: structural ops (insert/delete rows or columns,
// add/delete/duplicate/move sheets) shift addresses under the captured blocks,
// so a run containing them is marked unrestorable and falls back to native
// undo; visuals and sheet features the run adds (charts, tables, pivots,
// filters, validations) are not removed by a restore and are listed.
// ============================================================================

export type Bounds = { startRow: number; startColumn: number; endRow: number; endColumn: number };

/** Raw cell data as the grid API returns it (opaque here), or null for an empty cell. */
export type CellSnap = Record<string, unknown> | null;

export type BlockSnapshot = { sheetId: string; bounds: Bounds; cells: CellSnap[][]; reason: string };
export type ColumnWidthSnapshot = { sheetId: string; column: number; widthPx: number };
export type RowHeightSnapshot = { sheetId: string; row: number; heightPx: number };
export type MergeSnapshot = { sheetId: string; range: string; wasMerged: boolean };
export type RenameSnapshot = { sheetId: string; name: string };

export type RunSnapshot = {
  blocks: BlockSnapshot[];
  columnWidths: ColumnWidthSnapshot[];
  rowHeights: RowHeightSnapshot[];
  merges: MergeSnapshot[];
  renames: RenameSnapshot[];
  /** cells captured so far */
  cells: number;
  /** the cap was hit: rollback must be refused */
  truncated: boolean;
  /** op names that make address-based restore unreliable (fall back to native undo) */
  unrestorable: string[];
  /** op names whose effects a restore does not remove (told to the user) */
  notReverted: string[];
  batches: number;
};

export const RUN_SNAPSHOT_MAX_CELLS = 1_000_000;

export function emptyRunSnapshot(): RunSnapshot {
  return { blocks: [], columnWidths: [], rowHeights: [], merges: [], renames: [], cells: 0, truncated: false, unrestorable: [], notReverted: [], batches: 0 };
}

export const boundsCellCount = (b: Bounds): number => (b.endRow - b.startRow + 1) * (b.endColumn - b.startColumn + 1);

// --- What a plan touches -------------------------------------------------------------

export type PlanLike = {
  cellChanges: ReadonlyArray<{ sheetId: string; address: string }>;
  formatChanges: ReadonlyArray<{ sheetId: string; range: string }>;
  structuralChanges: ReadonlyArray<{ op: { op: string } & Record<string, unknown> }>;
  sheetRenames: ReadonlyArray<{ sheetId: string; before: string }>;
};

export type CaptureSpec = {
  blocks: Array<{ sheetId: string; bounds: Bounds; reason: string }>;
  /** 0-based column indexes whose width the batch changes */
  columns: Array<{ sheetId: string; column: number }>;
  /** 0-based row indexes whose height the batch changes */
  rows: Array<{ sheetId: string; row: number }>;
  merges: Array<{ sheetId: string; range: string; willMerge: boolean }>;
  renames: RenameSnapshot[];
  unrestorable: string[];
  notReverted: string[];
  /** ops whose write bounds are only known at execution (query_range, import_file): captured by the executor */
  deferred: string[];
};

const STRUCTURAL = new Set(["insert_rows", "delete_rows", "insert_cols", "delete_cols", "add_sheet", "delete_sheet", "duplicate_sheet", "move_sheet", "set_sheet_hidden"]);
const NOT_REVERTED = new Set([
  "add_chart", "edit_chart", "delete_visual", "add_sparkline", "add_shape", "edit_shape", "add_image", "add_pivot", "refresh_pivot",
  "add_table", "add_table_row", "add_table_column", "delete_table_row", "delete_table_column", "delete_table",
  "set_hyperlink", "set_filter", "clear_filter", "set_filter_criteria", "add_conditional_format", "clear_conditional_formats",
  "set_data_validation", "set_note", "add_defined_name", "delete_defined_name", "set_page_setup", "set_freeze", "protect_sheet",
  "set_rows_hidden", "set_cols_hidden",
]);
const DEFERRED = new Set(["query_range", "import_file"]);

type Helpers = { parseRange: (range: string) => Bounds; columnIndex: (label: string) => number };

/** Union bounding box of a set of bounds (same sheet). */
export function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (!list.length) return null;
  return list.reduce((acc, b) => ({
    startRow: Math.min(acc.startRow, b.startRow),
    startColumn: Math.min(acc.startColumn, b.startColumn),
    endRow: Math.max(acc.endRow, b.endRow),
    endColumn: Math.max(acc.endColumn, b.endColumn),
  }));
}

/**
 * Derive the capture spec for one plan. Per-cell changes on a sheet collapse
 * to their bounding box when it is dense, else stay individual cells, so a
 * run that edits A1 and ZZ9999 does not snapshot the whole sheet.
 */
export function captureSpecForPlan(plan: PlanLike, h: Helpers): CaptureSpec {
  const spec: CaptureSpec = { blocks: [], columns: [], rows: [], merges: [], renames: [], unrestorable: [], notReverted: [], deferred: [] };
  const cellsBySheet = new Map<string, Bounds[]>();
  for (const c of plan.cellChanges) {
    const b = h.parseRange(c.address);
    cellsBySheet.set(c.sheetId, [...(cellsBySheet.get(c.sheetId) ?? []), b]);
  }
  for (const [sheetId, list] of cellsBySheet) {
    const box = unionBounds(list)!;
    const dense = list.length >= boundsCellCount(box) * 0.5;
    if (dense || boundsCellCount(box) <= 5_000) spec.blocks.push({ sheetId, bounds: box, reason: "cell edits" });
    else for (const b of list) spec.blocks.push({ sheetId, bounds: b, reason: "cell edit" });
  }
  for (const f of plan.formatChanges) spec.blocks.push({ sheetId: f.sheetId, bounds: h.parseRange(f.range), reason: "format" });
  for (const r of plan.sheetRenames) spec.renames.push({ sheetId: r.sheetId, name: r.before });
  for (const { op } of plan.structuralChanges) {
    const name = op.op;
    const sheetId = String(op["sheetId"] ?? "");
    if (STRUCTURAL.has(name)) {
      spec.unrestorable.push(name);
      continue;
    }
    if (DEFERRED.has(name)) {
      spec.deferred.push(name);
      continue;
    }
    if (NOT_REVERTED.has(name)) {
      spec.notReverted.push(name);
      continue;
    }
    switch (name) {
      case "fill_range":
      case "convert_to_values":
      case "clear_range":
      case "find_replace":
      case "sort_range":
        spec.blocks.push({ sheetId, bounds: h.parseRange(String(op[name === "fill_range" ? "target" : "range"])), reason: name });
        break;
      case "copy_range": {
        const src = h.parseRange(String(op["source"]));
        const tgt = h.parseRange(String(op["target"]));
        const height = src.endRow - src.startRow;
        const width = src.endColumn - src.startColumn;
        spec.blocks.push({
          sheetId,
          bounds: { startRow: tgt.startRow, startColumn: tgt.startColumn, endRow: Math.max(tgt.endRow, tgt.startRow + height), endColumn: Math.max(tgt.endColumn, tgt.startColumn + width) },
          reason: name,
        });
        break;
      }
      case "set_col_width": {
        const start = h.columnIndex(String(op["column"]));
        const count = Number(op["count"] ?? 1);
        for (let i = 0; i < count; i++) spec.columns.push({ sheetId, column: start + i });
        break;
      }
      case "set_row_height": {
        const start = Number(op["row"]) - 1;
        const count = Number(op["count"] ?? 1);
        for (let i = 0; i < count; i++) spec.rows.push({ sheetId, row: start + i });
        break;
      }
      case "merge_cells":
        spec.merges.push({ sheetId, range: String(op["range"]), willMerge: true });
        break;
      case "unmerge_cells":
        spec.merges.push({ sheetId, range: String(op["range"]), willMerge: false });
        break;
      case "rename_sheet":
        // handled through plan.sheetRenames
        break;
      default:
        spec.notReverted.push(name);
    }
  }
  return spec;
}

// --- Accounting ------------------------------------------------------------------------

/** Add a captured block; false (and truncated=true) when the cap would be exceeded. */
export function addBlock(snap: RunSnapshot, block: BlockSnapshot): boolean {
  const n = boundsCellCount(block.bounds);
  if (snap.truncated || snap.cells + n > RUN_SNAPSHOT_MAX_CELLS) {
    snap.truncated = true;
    return false;
  }
  snap.blocks.push(block);
  snap.cells += n;
  return true;
}

export function noteBatch(snap: RunSnapshot, spec: Pick<CaptureSpec, "unrestorable" | "notReverted">): void {
  snap.batches += 1;
  for (const u of spec.unrestorable) if (!snap.unrestorable.includes(u)) snap.unrestorable.push(u);
  for (const n of spec.notReverted) if (!snap.notReverted.includes(n)) snap.notReverted.push(n);
}

export type Restorability = { ok: true; caveat: string | null } | { ok: false; reason: string };

/** Whether a full restore from the snapshot is trustworthy. */
export function restorability(snap: RunSnapshot): Restorability {
  if (snap.truncated) {
    return { ok: false, reason: `the run changed more than ${RUN_SNAPSHOT_MAX_CELLS.toLocaleString("en-US")} cells; the pre-run state could not be held. Reopen the last saved copy instead.` };
  }
  if (snap.unrestorable.length) {
    return { ok: false, reason: `the run inserted or deleted rows, columns or sheets (${snap.unrestorable.join(", ")}), which moves every later address; only the native undo history can revert it.` };
  }
  if (!snap.blocks.length && !snap.columnWidths.length && !snap.rowHeights.length && !snap.merges.length && !snap.renames.length) {
    return { ok: false, reason: "the run made no cell, width, merge or name changes to revert." };
  }
  const caveat = snap.notReverted.length
    ? `Charts, tables, filters or other sheet features the run added (${snap.notReverted.join(", ")}) stay; remove them by hand if unwanted.`
    : null;
  return { ok: true, caveat };
}

/** Restore steps, newest block first so overlapping writes unwind in order. */
export type RestoreStep =
  | { kind: "block"; block: BlockSnapshot }
  | { kind: "colWidth"; item: ColumnWidthSnapshot }
  | { kind: "rowHeight"; item: RowHeightSnapshot }
  | { kind: "merge"; item: MergeSnapshot }
  | { kind: "rename"; item: RenameSnapshot };

export function restoreSteps(snap: RunSnapshot): RestoreStep[] {
  const steps: RestoreStep[] = [];
  for (let i = snap.blocks.length - 1; i >= 0; i--) steps.push({ kind: "block", block: snap.blocks[i]! });
  // first-captured width/height/name wins: that is the pre-run state
  const seenCol = new Set<string>();
  for (const w of snap.columnWidths) {
    const k = `${w.sheetId}:${w.column}`;
    if (seenCol.has(k)) continue;
    seenCol.add(k);
    steps.push({ kind: "colWidth", item: w });
  }
  const seenRow = new Set<string>();
  for (const r of snap.rowHeights) {
    const k = `${r.sheetId}:${r.row}`;
    if (seenRow.has(k)) continue;
    seenRow.add(k);
    steps.push({ kind: "rowHeight", item: r });
  }
  for (let i = snap.merges.length - 1; i >= 0; i--) steps.push({ kind: "merge", item: snap.merges[i]! });
  const seenSheet = new Set<string>();
  for (const r of snap.renames) {
    if (seenSheet.has(r.sheetId)) continue;
    seenSheet.add(r.sheetId);
    steps.push({ kind: "rename", item: r });
  }
  return steps;
}

/** The cell data that clears a cell completely on write-back. */
export const EMPTY_CELL_WRITE: Record<string, unknown> = { v: null, f: null, si: null, p: null, s: null, t: null };
