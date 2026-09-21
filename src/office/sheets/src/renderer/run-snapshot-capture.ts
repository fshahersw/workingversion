import type { IRange } from '@univerjs/core'
import {
  EMPTY_CELL_WRITE,
  addBlock,
  boundsCellCount,
  captureSpecForPlan,
  emptyRunSnapshot,
  noteBatch,
  restorability,
  restoreSteps,
  RUN_SNAPSHOT_MAX_CELLS,
  type Bounds,
  type CaptureSpec,
  type CellSnap,
  type PlanLike,
  type RunSnapshot,
} from '@/lib/sheets/run-snapshot'
import { columnIndex, parseRange } from '../domain/cell-address'
import type { ActiveWorkbook, LazyWorkbookState, UniverRuntime, UniverWorksheet } from './univer-state'
import { applyRangeInLoadedChunks } from './univer-sync'

/**
 * Renderer side of the Sheets run snapshot: reads the prior cell data of the
 * blocks a batch is about to write (through the same chunk loader the
 * executors use, so streamed regions are materialized first) and writes it
 * back on rollback. The policy (what to capture, the cap, restore order)
 * lives in src/lib/sheets/run-snapshot.ts.
 */
export type SnapshotContext = {
  runtime: UniverRuntime
  lazyWorkbookRef: { current: LazyWorkbookState | null }
  workbook: ActiveWorkbook
  setMessage: (message: string) => void
}

export { emptyRunSnapshot, restorability, RUN_SNAPSHOT_MAX_CELLS }
export type { RunSnapshot }

const clamp = (b: Bounds, sheet: UniverWorksheet): Bounds => ({
  startRow: Math.max(0, b.startRow),
  startColumn: Math.max(0, b.startColumn),
  endRow: Math.min(b.endRow, sheet.getMaxRows() - 1),
  endColumn: Math.min(b.endColumn, sheet.getMaxColumns() - 1),
})

/** Deep copy so later grid mutations cannot alias the captured cell objects. */
function cloneCell(cell: unknown): CellSnap {
  if (cell === null || cell === undefined) return null
  if (typeof cell !== 'object') return null
  try {
    return structuredClone(cell as Record<string, unknown>)
  } catch {
    return JSON.parse(JSON.stringify(cell)) as Record<string, unknown>
  }
}

/** Capture one block's prior cells into the run snapshot (no-op past the cap). */
export async function captureBlock(
  ctx: SnapshotContext,
  snap: RunSnapshot,
  sheetId: string,
  rawBounds: Bounds,
  reason: string,
): Promise<void> {
  const sheet = ctx.workbook.getSheetBySheetId(sheetId)
  if (!sheet) return
  const bounds = clamp(rawBounds, sheet)
  if (bounds.endRow < bounds.startRow || bounds.endColumn < bounds.startColumn) return
  if (snap.truncated || snap.cells + boundsCellCount(bounds) > RUN_SNAPSHOT_MAX_CELLS) {
    snap.truncated = true
    return
  }
  const height = bounds.endRow - bounds.startRow + 1
  const width = bounds.endColumn - bounds.startColumn + 1
  const cells: CellSnap[][] = Array.from({ length: height }, () => new Array<CellSnap>(width).fill(null))
  await applyRangeInLoadedChunks(
    ctx.runtime,
    ctx.lazyWorkbookRef,
    sheet,
    bounds as IRange,
    (chunk) => {
      const data = sheet
        .getRange(chunk.startRow, chunk.startColumn, chunk.endRow - chunk.startRow + 1, chunk.endColumn - chunk.startColumn + 1)
        .getCellDatas() as unknown as (Record<string, unknown> | null | undefined)[][]
      for (let r = chunk.startRow; r <= chunk.endRow; r += 1) {
        for (let c = chunk.startColumn; c <= chunk.endColumn; c += 1) {
          cells[r - bounds.startRow]![c - bounds.startColumn] = cloneCell(data[r - chunk.startRow]?.[c - chunk.startColumn])
        }
      }
    },
    ctx.setMessage,
    { neighborColumns: false },
  )
  addBlock(snap, { sheetId, bounds, cells, reason })
}

/**
 * Capture everything a plan will change, BEFORE it applies. Blocks whose
 * bounds are only known at execution (query_range / import_file) are captured
 * by the executor through captureBlock when it knows its write bounds.
 */
export async function captureForPlan(ctx: SnapshotContext, snap: RunSnapshot, plan: PlanLike): Promise<CaptureSpec> {
  const spec = captureSpecForPlan(plan, { parseRange, columnIndex })
  noteBatch(snap, spec)
  for (const b of spec.blocks) await captureBlock(ctx, snap, b.sheetId, b.bounds, b.reason)
  for (const c of spec.columns) {
    const sheet = ctx.workbook.getSheetBySheetId(c.sheetId)
    if (!sheet) continue
    const widthPx = sheet.getSheet().getColumnWidth(c.column)
    if (Number.isFinite(widthPx)) snap.columnWidths.push({ sheetId: c.sheetId, column: c.column, widthPx })
  }
  for (const r of spec.rows) {
    const sheet = ctx.workbook.getSheetBySheetId(r.sheetId)
    if (!sheet) continue
    const heightPx = sheet.getSheet().getRowHeight(r.row)
    if (Number.isFinite(heightPx)) snap.rowHeights.push({ sheetId: r.sheetId, row: r.row, heightPx })
  }
  for (const m of spec.merges) {
    const sheet = ctx.workbook.getSheetBySheetId(m.sheetId)
    if (!sheet) continue
    const target = parseRange(m.range)
    const wasMerged = sheet
      .getSheet()
      .getMergeData()
      .some(
        (mr) =>
          mr.startRow === target.startRow && mr.endRow === target.endRow && mr.startColumn === target.startColumn && mr.endColumn === target.endColumn,
      )
    // merging: capture the cells too, since a merge clears the non-anchor cells
    if (m.willMerge) await captureBlock(ctx, snap, m.sheetId, target, 'merge_cells')
    snap.merges.push({ sheetId: m.sheetId, range: m.range, wasMerged })
  }
  for (const r of spec.renames) snap.renames.push(r)
  return spec
}

export type RestoreResult = { ok: true; caveat: string | null; steps: number } | { ok: false; reason: string }

/** Write the pre-run state back. Refuses (with the reason) when the snapshot is not trustworthy. */
export async function restoreRunSnapshot(ctx: SnapshotContext, snap: RunSnapshot): Promise<RestoreResult> {
  const check = restorability(snap)
  if (!check.ok) return check
  const steps = restoreSteps(snap)
  for (const step of steps) {
    if (step.kind === 'block') {
      const { sheetId, bounds, cells } = step.block
      const sheet = ctx.workbook.getSheetBySheetId(sheetId)
      if (!sheet) continue
      await applyRangeInLoadedChunks(
        ctx.runtime,
        ctx.lazyWorkbookRef,
        sheet,
        bounds as IRange,
        (chunk) => {
          const matrix: Record<string, unknown>[][] = []
          for (let r = chunk.startRow; r <= chunk.endRow; r += 1) {
            const row: Record<string, unknown>[] = []
            for (let c = chunk.startColumn; c <= chunk.endColumn; c += 1) {
              const cell = cells[r - bounds.startRow]?.[c - bounds.startColumn] ?? null
              row.push(cell ? { ...EMPTY_CELL_WRITE, ...cell } : { ...EMPTY_CELL_WRITE })
            }
            matrix.push(row)
          }
          sheet
            .getRange(chunk.startRow, chunk.startColumn, chunk.endRow - chunk.startRow + 1, chunk.endColumn - chunk.startColumn + 1)
            .setValues(matrix as never)
        },
        ctx.setMessage,
        { neighborColumns: false },
      )
    } else if (step.kind === 'colWidth') {
      ctx.workbook.getSheetBySheetId(step.item.sheetId)?.setColumnWidths(step.item.column, 1, Math.round(step.item.widthPx))
    } else if (step.kind === 'rowHeight') {
      ctx.workbook.getSheetBySheetId(step.item.sheetId)?.setRowHeights(step.item.row, 1, Math.round(step.item.heightPx))
    } else if (step.kind === 'merge') {
      const sheet = ctx.workbook.getSheetBySheetId(step.item.sheetId)
      if (!sheet) continue
      if (step.item.wasMerged) sheet.getRange(step.item.range).merge()
      else sheet.getRange(step.item.range).breakApart()
    } else if (step.kind === 'rename') {
      ctx.workbook.getSheetBySheetId(step.item.sheetId)?.setName(step.item.name)
    }
  }
  return { ok: true, caveat: check.caveat, steps: steps.length }
}
