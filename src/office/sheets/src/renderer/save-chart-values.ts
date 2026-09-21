import { parseRange, rangeCellCount } from '../domain/cell-address'
import { applyChartStateEdit, splitSheetRef } from '../domain/chart-visual'
import { numericChartCache } from '../domain/chart-cache'
import type { WorkbookChartEdit, WorkbookVisualAdd } from '../shared/desktop-api'
import { CHART_CATEGORY_WIRE_MAX } from '../shared/desktop-api'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'

const EDITABLE_PLOTS = new Set(['barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart', 'radarChart'])
const MAX_REFRESH_CELLS = 100_000
type Series = {
  values: readonly number[]
  blanks?: readonly number[]
  categories?: readonly string[]
  valuesRef?: string
  categoriesRef?: string
  categoryGroups?: readonly unknown[]
}

/** Called once after successful save-time calculation. Produce fresh cache
 * payloads without changing the journal, charts on screen, styles, or refs.
 * Imported chart types/refs the surgical writer cannot handle remain untouched.
 * Streamed/manual workbooks retain their existing cache-preservation behavior. */
export function synchronizeSavedChartCaches(
  runtime: UniverRuntime | null,
  state: LazyWorkbookState,
  chartEdits: WorkbookChartEdit[],
  visualAdditions: WorkbookVisualAdd[],
  manualCalculation: boolean,
): { chartEdits: WorkbookChartEdit[]; visualAdditions: WorkbookVisualAdd[] } {
  if (!runtime || !state.formulaMode || !state.flags.preloadComplete || manualCalculation) {
    return { chartEdits, visualAdditions }
  }
  const workbook = runtime.univerAPI.getActiveWorkbook()
  if (!workbook) throw new Error('The workbook closed while preparing chart caches.')
  const sheets = workbook.getSheets()
  const byName = new Map(sheets.map((sheet) => [sheet.getSheetName().toLowerCase(), sheet]))
  // A pending rename is also applied by the package writer. Original chart
  // refs may still use that source name; resolve it by stable sheet id.
  for (const original of state.file.sheets) {
    const sheet = workbook.getSheetBySheetId(original.id)
    if (sheet && !byName.has(original.name.toLowerCase())) byName.set(original.name.toLowerCase(), sheet)
  }
  const vectors = new Map<string, unknown[]>()
  let cellsRead = 0
  const read = (ref: string, chart: string): unknown[] | null => {
    const split = splitSheetRef(ref)
    // Named/external/3D refs and non-vector expressions are not rewritten by
    // this cache-only operation. Preserve the original OOXML for those.
    if (!split || /[\[\]:]/.test(split.sheetName)) return null
    let bounds
    try { bounds = parseRange(split.range) } catch { return null }
    if (bounds.startRow !== bounds.endRow && bounds.startColumn !== bounds.endColumn) return null
    const count = rangeCellCount(bounds)
    if (count > 1000) return null
    const sheet = byName.get(split.sheetName.toLowerCase())
    if (!sheet || state.editJournal.sheets.removed.has(sheet.getSheetId())) {
      throw new Error(`Chart "${chart}" references unavailable sheet "${split.sheetName}". Repair the chart reference before saving.`)
    }
    const key = `${sheet.getSheetId()}:${split.range}`
    const cached = vectors.get(key)
    if (cached) return cached
    if (cellsRead + count > MAX_REFRESH_CELLS) return null
    cellsRead += count
    const matrix = sheet.getSheet().getCellMatrix()
    const result: unknown[] = []
    for (let row = bounds.startRow; row <= bounds.endRow; row++) {
      for (let column = bounds.startColumn; column <= bounds.endColumn; column++) {
        const cell = matrix.getValue(row, column)
        const value = cell?.v
        if ((cell?.f || cell?.si) && (value === null || value === undefined ||
          (typeof value === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA|ERROR!)/.test(value)))) {
          throw new Error(`Chart "${chart}" has an unresolved formula in ${ref}. Calculate or repair it before saving.`)
        }
        result.push(value)
      }
    }
    vectors.set(key, result)
    return result
  }
  const refresh = (series: Series, label: string): { values?: number[]; blanks?: number[]; categories?: string[] } => {
    const patch: { values?: number[]; blanks?: number[]; categories?: string[] } = {}
    // Cache-less imported vectors stay cache-less (the renderer hydrates them).
    if (series.valuesRef && series.values.length) {
      const raw = read(series.valuesRef, label)
      if (raw) {
        const cache = numericChartCache(raw)
        if (!cache) throw new Error(`Chart "${label}" has an error in ${series.valuesRef}. Calculate or repair it before saving.`)
        if (JSON.stringify(cache.values) !== JSON.stringify(series.values) ||
          JSON.stringify(cache.blanks) !== JSON.stringify(series.blanks ?? [])) Object.assign(patch, cache)
      }
    }
    // Replacing a multi-level category cache would flatten its hierarchy.
    if (series.categoriesRef && series.categories?.length && !series.categoryGroups?.length) {
      const raw = read(series.categoriesRef, label)
      if (raw) {
        const categories = raw.map((value) => String(value ?? ''))
        if (categories.some((value) => value.length > CHART_CATEGORY_WIRE_MAX)) return patch
        if (JSON.stringify(categories) !== JSON.stringify(series.categories)) patch.categories = categories
      }
    }
    return patch
  }
  const edits = new Map(chartEdits.map((edit) => [edit.chartPath, edit]))
  for (const visual of state.file.visuals) {
    if (!visual.chartPath || !visual.chart || visual.kind !== 'chart' ||
      state.editJournal.sheets.removed.has(visual.sheetId) || state.editJournal.visualEdits.get(visual.id)?.remove ||
      visual.chart.chartTypes.some((type) => !EDITABLE_PLOTS.has(type))) continue
    const pending = edits.get(visual.chartPath)
    const effective = applyChartStateEdit(visual.chart, pending)
    if (effective.series.length > 24 || (!pending && edits.size >= 100)) continue
    const entries = new Map((pending?.series ?? []).map((entry) => [entry.index, entry]))
    let changed = false
    effective.series.forEach((series, index) => {
      const patch = refresh(series, effective.title || visual.chartPath!)
      if (!Object.keys(patch).length) return
      changed = true
      entries.set(index, { ...entries.get(index), index, ...patch })
    })
    if (!changed) continue
    if (entries.size > 24) continue
    edits.set(visual.chartPath, { ...pending, chartPath: visual.chartPath, series: [...entries.values()] })
  }
  if (edits.size > 100) throw new Error('This save needs more than 100 chart edits; reduce the workbook chart changes before saving.')
  const additions = visualAdditions.map((visual) => {
    if (!visual.chart) return visual
    return { ...visual, chart: { ...visual.chart, series: visual.chart.series.map((series) => ({
      ...series, ...refresh(series, visual.chart!.title),
    })) } }
  })
  return { chartEdits: [...edits.values()], visualAdditions: additions }
}
