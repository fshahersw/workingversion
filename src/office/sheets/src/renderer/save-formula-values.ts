import { FormulaExecutedStateType } from '@univerjs/engine-formula'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'

export interface SavedFormulaValue {
  sheetId: string
  row: number
  column: number
  value: string | number | boolean
}

/** The journal is mutable. Compare its contents across the calculation wait,
 * including structural edits and names, before taking the save snapshot. */
export function saveJournalSnapshot(state: LazyWorkbookState): string {
  return JSON.stringify(state.editJournal, (_key, value: unknown) =>
    value instanceof Map || value instanceof Set ? [...value] : value,
  )
}

/** Only a fully loaded workbook has every precedent available to Univer.
 * Read the raw model after results are applied, never the formatted display
 * or cached-value fallback used to render unsupported Excel functions. */
export async function collectLiveFormulaValues(
  runtime: UniverRuntime | null,
  state: LazyWorkbookState,
  isCurrent: () => boolean,
  manualCalculation: boolean,
): Promise<SavedFormulaValue[]> {
  if (!runtime || !state.formulaMode || !state.flags.preloadComplete || manualCalculation) return []
  const workbook = runtime.univerAPI.getActiveWorkbook()
  if (!workbook) return []
  const cells: Array<{ sheetId: string; row: number; column: number }> = []
  for (const sheet of workbook.getSheets()) {
    if (state.editJournal.sheets.removed.has(sheet.getSheetId())) continue
    sheet.getSheet().getCellMatrix().forValue((row, column, cell) => {
      if (cell?.f || cell?.si) cells.push({ sheetId: sheet.getSheetId(), row, column })
    })
  }
  if (cells.length === 0) return []
  const formula = runtime.univerAPI.getFormula()
  let started = false
  let succeeded = false
  const start = formula.calculationStart(() => { started = true; succeeded = false })
  const end = formula.calculationEnd((status) => {
    if (started) succeeded = status === FormulaExecutedStateType.SUCCESS
  })
  try {
    // Register before triggering: fast calculations can finish synchronously.
    const applied = formula.onCalculationResultApplied(5_000)
    // A synchronous trigger failure must not leave an unhandled wait timeout.
    void applied.catch(() => undefined)
    formula.executeCalculation()
    await applied
    if (!isCurrent() || runtime.univerAPI.getActiveWorkbook()?.getId() !== workbook.getId()) {
      throw new Error('The workbook changed while preparing the save. Save again after editing finishes.')
    }
    if (!started || !succeeded) {
      throw new Error('Formula calculation did not finish. Calculate the workbook and save again.')
    }
    return cells.flatMap(({ sheetId, row, column }) => {
      const sheet = workbook.getSheetBySheetId(sheetId)
      const cell = sheet?.getSheet().getCellMatrix().getValue(row, column)
      if (!cell?.f && !cell?.si) return []
      const value = cell.v
      // Unsupported/error results must not replace a source Office cache with
      // a display fallback or an invented value. Excel recalculates on open.
      if (typeof value === 'string' && /^(?:#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!|GETTING_DATA)|#ERROR!)$/.test(value)) return []
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return []
      if (typeof value === 'string' && value.length > 10_000) return []
      if (typeof value === 'number' && !Number.isFinite(value)) return []
      // Univer represents BOOLEAN model values as 0/1 (CellValueType = 3).
      return [{ sheetId, row, column, value: cell.t === 3 ? Boolean(value) : value }]
    })
  } finally {
    start.dispose()
    end.dispose()
  }
}
