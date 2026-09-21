import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod4'
import * as saveCommit from '../../office/sheets/src/renderer/save-commit-lock'

let moduleNumber = 0
async function actualModule(relative: string, imports: Record<string, unknown> = {}, extra = '') {
  const key = `__chartCacheRegression${moduleNumber++}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[key] = imports
  try {
    const source = await readFile(new URL(`../../office/sheets/src/${relative}`, import.meta.url), 'utf8')
    const code = (await transform(source + extra, { loader: 'ts', format: 'esm', target: 'es2022' })).code
      .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
    return await import(`data:text/javascript;base64,${Buffer.from(`const { ${Object.keys(imports).join(', ')} } = globalThis.${key};\n${code}`).toString('base64')}`)
  } finally { delete globals[key] }
}
const cache = await actualModule('domain/chart-cache.ts')
const address = await actualModule('domain/cell-address.ts')
const chart = await actualModule('domain/chart-visual.ts', { ...cache, ...address })
const native = await actualModule('gateway/xlsx-chart.ts', cache)
const writer = await actualModule('gateway/xlsx-drawing-add.ts', { ...cache, ...native })
const channels = await actualModule('shared/ipc-channels.ts')
const shapes = await actualModule('shared/shape-types.ts')
const wire = await actualModule('shared/desktop-api.ts', { z, ...channels, ...shapes })
const journal = await actualModule('renderer/edit-journal.ts', { ...address, ...chart, ...shapes,
  CHART_TEXT_WIRE_MAX: 255, CHART_CATEGORY_WIRE_MAX: 1024, INDENT_STEP_PX: 9 })
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false })
const array = (v: any) => Array.isArray(v) ? v : v == null ? [] : [v]
const series = { name: 'Revenue', categories: ['A', 'B', 'C', 'D'], values: [12, 0, 0, 9], blanks: [1],
  valuesRef: "'Summary'!$B$2:$B$5", categoriesRef: "'Summary'!$A$2:$A$5", color: '#172E4C' }

function assertSparse(xml: string, plot: string, tag = 'c:val') {
  const parsed = parser.parse(xml)
  const root = parsed['c:chartSpace']?.['c:chart'] ?? parsed['c:chart']
  const ser = array((root['c:plotArea'] ?? root)[plot]['c:ser'])[0]
  const values = ser[tag]['c:numRef']['c:numCache']
  assert.equal(values['c:ptCount']['@val'], '4')
  assert.deepEqual(array(values['c:pt']).map((p: any) => [p['@idx'], p['c:v']]), [['0', '12'], ['2', '0'], ['3', '9']])
  assert.equal(ser[tag]['c:numRef']['c:f'], series.valuesRef)
  assert.match(xml, /172E4C/)
}

test('numeric caches distinguish missing/text points from real zero and reject calculation errors', () => {
  assert.deepEqual(cache.numericChartCache([12, null, 0, '9', '', 'N/M', undefined, false]),
    { values: [12, 0, 0, 9, 0, 0, 0, 0], blanks: [1, 4, 5, 6, 7] })
  assert.equal(cache.numericChartCache([1, '#DIV/0!']), null)
  assert.throws(() => cache.numericChartPoints([0], [1]), /indexes/)
})

test('actual new-chart native XML preserves sparse indices and real zero for line and scatter', () => {
  for (const type of ['line', 'scatter']) {
    const xml = writer.buildChartXml({ chartType: type, title: 'Sparse revenue', series: [series] })
    assertSparse(xml, type === 'line' ? 'c:lineChart' : 'c:scatterChart', type === 'line' ? 'c:val' : 'c:yVal')
  }
})

test('actual imported chart XML sparse edit and full replacement preserve references/style/blank display', () => {
  const initial = writer.buildChartXml({ chartType: 'line', title: 'Sparse revenue', series: [{ ...series, blanks: [], values: [1, 2, 3, 4] }] })
    .replace('<c:formatCode>General</c:formatCode>', '<c:formatCode>0.00%</c:formatCode>')
  const edited = native.applyChartEdit(initial, { chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, values: series.values, blanks: series.blanks }] })
  assertSparse(edited, 'c:lineChart')
  assert.match(edited, /<c:formatCode>0.00%<\/c:formatCode>/)
  assert.equal(edited.match(/<c:dispBlanksAs[^>]*>/)?.[0], initial.match(/<c:dispBlanksAs[^>]*>/)?.[0])
  assertSparse(native.applyChartEdit(initial, { chartPath: 'xl/charts/chart1.xml', seriesSet: [series] }), 'c:lineChart')
})

test('actual browser Zod4 wire schemas retain valid gaps and reject missing/out-of-bounds vectors', () => {
  assert.deepEqual(wire.workbookChartEditSchema.parse({ chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, values: series.values, blanks: [1] }] }).series[0].blanks, [1])
  assert.equal(wire.workbookChartEditSchema.safeParse({ chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, name: 'A', blanks: [0] }] }).success, false)
  assert.equal(wire.workbookChartEditSchema.safeParse({ chartPath: 'xl/charts/chart1.xml', seriesSet: [{ ...series, blanks: [4] }] }).success, false)
  const addition = wire.workbookVisualAddSchema.safeParse({ sheetId: 's', anchor: { fromRow: 0, fromColumn: 0, fromRowOffset: 0, fromColumnOffset: 0, toRow: 20, toColumn: 8, toRowOffset: 0, toColumnOffset: 0 }, chart: { chartType: 'line', title: 'A', series: [series] } })
  assert.equal(addition.success, true, JSON.stringify(addition.error?.issues))
})

test('new chart construction and journal round trip retain gaps; dense replacement clears old gaps', () => {
  const parsed = chart.chartDataFromValues([['Quarter', 'Revenue'], ['Q1', 12], ['Q2', null], ['Q3', 0], ['Q4', 9]])
  assert.deepEqual(parsed.series[0].blanks, [1])
  const state = { series: [series], chartTypes: ['lineChart'], title: 'Revenue' }
  const transposed = chart.transposeChartSeries(state.series, (i: number) => `Series ${i}`)
  assert.deepEqual(transposed[1].blanks, [0])
  const j = { chartEdits: new Map() }
  journal.recordChartEdit(j, 'xl/charts/chart1.xml', { series: [{ index: 0, values: series.values, blanks: [1] }] })
  assert.deepEqual(journal.toSaveChartEdits(j)[0].series[0].blanks, [1])
  journal.recordChartEdit(j, 'xl/charts/chart1.xml', { series: [{ index: 0, values: [12, 15, 0, 9] }] })
  assert.equal(chart.applyChartStateEdit(state, j.chartEdits.get('xl/charts/chart1.xml')).series[0].blanks, undefined)
})

test('financial numeric year headers become categories without classifying ambiguous numeric data as headers', () => {
  const grid = [['Line item (USD millions)', 2021, 2022, 2023, 2024, 2025],
    ['Automotive revenues', 37, 58, 79, 87, 106], ['Energy revenues', 6, 9, 12, 16, 22], ['Services revenues', 5, 7, 10, 12, 15]]
  const parsed = chart.chartDataFromValues(grid)
  assert.deepEqual(parsed.categories, ['2021', '2022', '2023', '2024', '2025'])
  assert.equal(parsed.series.length, 3)
  assert.equal(parsed.series[0].name, 'Automotive revenues')
  const visual = chart.buildChartVisual({ id: 'chart', sheetId: 'summary', sheetName: 'Annual Summary', chartType: 'column', dataRange: 'A4:F7', values: grid })
  assert.equal(visual.chart.series[0].categoriesRef, "'Annual Summary'!$B$4:$F$4")
  assert.equal(visual.chart.series[0].valuesRef, "'Annual Summary'!$B$5:$F$5")
  const ambiguous = chart.chartDataFromValues([['Units', 2021, 2022, 2023], ['Revenue', 10, 20, 30]])
  assert.equal(ambiguous.hasCategoryColumn, false)
  assert.equal(ambiguous.series.length, 2)
  const metricsOnly = chart.chartDataFromValues([['Net income', 10, 20, 30], ['Net margin (%)', .1, .2, .3]])
  assert.deepEqual(metricsOnly.categories, ['1', '2', '3']) // no invented year labels
})

test('axis-format-only DSL edits reach live/demo charts and new-chart save serialization without dropping either axis', async () => {
  const dsl = await actualModule('domain/workbook-dsl.ts', { z, ...address, ...shapes })
  const actions = await actualModule('renderer/visual-actions.ts')
  const demo = await actualModule('domain/in-memory-workbook.ts', { ...dsl, ...address, ...chart })
  const operation = dsl.workbookOperationSchema.parse({ op: 'edit_chart', chartPath: 'demo-chart-margin',
    valueAxisFormats: { primary: '"$"#,##0', secondary: '0.0%' } })
  const expanded = dsl.expandToPrimitiveOps([operation], () => ({ value: null }))
  assert.equal(expanded[0].valueAxisFormats.secondary, '0.0%')
  for (const invalid of [{}, { secondary: '' }, { primary: 'x'.repeat(65) }, { secondary: null }, { other: '0%' }]) {
    assert.equal(dsl.workbookOperationSchema.safeParse({ ...operation, valueAxisFormats: invalid }).success, false)
  }
  const edit = await actions.buildAiChartEdit({}, {}, null, operation)
  assert.deepEqual(edit.valueAxisFormats, operation.valueAxisFormats)
  const visual = chart.buildChartVisual({ id: 'demo-chart-margin', sheetId: 's', sheetName: 'Summary', chartType: 'combo',
    title: 'Income and margin', dataRange: 'A1:C3', values: [['Year', 'Income', 'Margin'], ['2024', 12, .1], ['2025', 15, .2]] })
  assert.ok(visual.chart.secondaryYAxis)
  const adapter = new demo.InMemoryWorkbookAdapter({ revision: 0, sheets: [{ id: 's', name: 'Summary', cells: {}, visuals: [visual] }] })
  const plan = adapter.plan({ dslVersion: 1, transactionId: 'axis-format', baseRevision: 0, summary: 'Format both axes', operations: [operation] })
  adapter.apply(plan)
  const effective = adapter.getSnapshot().sheets[0].visuals[0].chart
  assert.equal(effective.yAxis.numFmt, '"$"#,##0')
  assert.equal(effective.secondaryYAxis.numFmt, '0.0%')
  const j = { sheets: { removed: new Set() }, visualAdds: [{ ...visual, chart: effective }], chartEdits: new Map() }
  const addition = wire.workbookVisualAddSchema.parse(journal.toSaveVisualAdds(j)[0])
  assert.deepEqual(addition.chart.valueAxisFormats, operation.valueAxisFormats)
  const xml = writer.buildChartXml(addition.chart)
  assert.match(xml, /formatCode="0.0%" sourceLinked="0"/)
  journal.recordChartEdit(j, 'xl/charts/chart1.xml', { valueAxisFormats: { primary: '#,##0' } })
  journal.recordChartEdit(j, 'xl/charts/chart1.xml', { valueAxisFormats: { secondary: '0.0%' } })
  assert.deepEqual(journal.toSaveChartEdits(j)[0].valueAxisFormats, { primary: '#,##0', secondary: '0.0%' })
  assert.match(chart.chartValueAxisFormatError({ chartTypes: ['pieChart'], series: [] }, { primary: '0%' }), /no value axis/)
  assert.match(chart.chartValueAxisFormatError({ chartTypes: ['lineChart'], series: [series] }, { secondary: '0%' }), /no supported secondary/)
  const importedSameAxis = { ...visual, chart: { ...visual.chart, secondaryYAxis: undefined } }
  const importedAdapter = new demo.InMemoryWorkbookAdapter({ revision: 0, sheets: [{ id: 's', name: 'Summary', cells: {}, visuals: [importedSameAxis] }] })
  assert.throws(() => importedAdapter.plan({ dslVersion: 1, transactionId: 'imported-axis', baseRevision: 0, summary: 'Invalid secondary axis', operations: [operation] }), /no supported secondary/)
  assert.equal(importedAdapter.getSnapshot().sheets[0].visuals[0].chart.secondaryYAxis, undefined)
  assert.equal(importedAdapter.getSnapshot().revision, 0)
})

test('native formats target the right secondary axis and independent primary axis, preserving other XML', () => {
  const initial = writer.buildChartXml({ chartType: 'combo', title: 'Income and margin', axisTitles: { category: 'Year', value: 'USD millions' }, series: [series, { ...series, name: 'Margin' }] })
  const edit = wire.workbookChartEditSchema.parse({ chartPath: 'xl/charts/chart1.xml', valueAxisFormats: { primary: '"$"#,##0.00', secondary: '0.0%' } })
  const formatted = native.applyChartEdit(initial, edit)
  const axes = parser.parse(formatted)['c:chartSpace']['c:chart']['c:plotArea']['c:valAx']
  assert.equal(axes.find((axis: any) => axis['c:axPos']['@val'] === 'l')['c:numFmt']['@formatCode'], '"$"#,##0.00')
  assert.equal(axes.find((axis: any) => axis['c:axPos']['@val'] === 'r')['c:numFmt']['@formatCode'], '0.0%')
  assert.equal(formatted.replace(/<c:numFmt\b[^>]*\/>/g, ''), initial)
  const second = native.applyChartEdit(formatted, { chartPath: 'xl/charts/chart1.xml', valueAxisFormats: { primary: 'General' } })
  assert.match(second, /formatCode="0.0%" sourceLinked="0"/)
  assert.match(second, /formatCode="General" sourceLinked="0"/)
  const single = writer.buildChartXml({ chartType: 'line', title: 'Revenue', series: [series] })
  assert.throws(() => native.applyChartEdit(single, { chartPath: 'xl/charts/chart1.xml', valueAxisFormats: { secondary: '0%' } }), /secondary value axis/)
  const scatter = writer.buildChartXml({ chartType: 'scatter', title: 'Scatter', series: [series] })
  const scatterFormatted = native.applyChartEdit(scatter, { chartPath: 'xl/charts/chart1.xml', valueAxisFormats: { primary: '0.00' } })
  const scatterAxes = parser.parse(scatterFormatted)['c:chartSpace']['c:chart']['c:plotArea']['c:valAx']
  assert.equal(scatterAxes.find((axis: any) => axis['c:axPos']['@val'] === 'b')['c:numFmt'], undefined)
  assert.equal(scatterAxes.find((axis: any) => axis['c:axPos']['@val'] === 'l')['c:numFmt']['@formatCode'], '0.00')
})

async function liveFixture() {
  const timers = new Map<number, Function>(); let timerId = 0
  let read: () => Promise<unknown[][]> = async () => [[25], [null], [0], [9]]
  const sync = await actualModule('renderer/visual-edit-sync.ts', { ...address, ...chart, ...cache, ...journal, ...saveCommit,
    readChartGridValues: () => read(),
    setTimeout: (fn: Function) => { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout: (id: number) => timers.delete(id),
  }, '\nexport { runChartDataSync };')
  const state = { file: { visuals: [{ id: 'chart', sheetId: 'summary', kind: 'chart', chartPath: 'xl/charts/chart1.xml', chart: { chartTypes: ['lineChart'], title: 'Revenue', series: [series] } }] },
    editJournal: { chartEdits: new Map(), visualEdits: new Map(), visualAdds: [] } }
  const sheet = { getSheetId: () => 'summary', getSheetName: () => 'Summary' }
  // Facades can return a fresh wrapper for the same workbook each call.
  const runtime = { univerAPI: { getActiveWorkbook: () => ({ getId: () => 'workbook', getSheets: () => [sheet] }) } }
  const refresh: any[] = []
  const ctx: any = { univerRef: { current: runtime }, lazyWorkbookRef: { current: state }, adapterRef: { current: {} },
    chartSyncRef: { current: { timer: null, dirty: new Map() } }, setMessage: (s: string) => refresh.push(s), refreshLazyVisuals: (s: any) => refresh.push(s) }
  const bounds = { startRow: 1, endRow: 4, startColumn: 1, endColumn: 1 }
  return { ctx, state, sync, refresh, timers, dirty: () => sync.queueChartDataSync(ctx, 'summary', bounds),
    setRead: (next: typeof read) => { read = next } }
}

test('actual live chart sync updates recalculated dependent ranges and preserves sparse caches', async () => {
  const f = await liveFixture(); f.dirty(); await f.sync.runChartDataSync(f.ctx)
  assert.deepEqual(f.state.editJournal.chartEdits.get('xl/charts/chart1.xml').series[0],
    { index: 0, values: [25, 0, 0, 9], blanks: [1], valuesRef: series.valuesRef })
  assert.equal(f.refresh.length, 1)
})

test('actual live chart writes wait for the native save commit window to close', async () => {
  const f = await liveFixture(); f.dirty()
  const release = saveCommit.beginWorkbookSaveCommit(f.state)
  try {
    await f.sync.runChartDataSync(f.ctx)
    assert.equal(f.state.editJournal.chartEdits.size, 0)
    assert.equal(f.ctx.chartSyncRef.current.dirty.size, 1)
    f.sync.applyChartEdit(f.ctx, 'xl/charts/chart1.xml', { title: 'Too late' })
    assert.equal(f.state.editJournal.chartEdits.size, 0)
  } finally { release() }
  await f.sync.runChartDataSync(f.ctx)
  assert.equal(f.state.editJournal.chartEdits.get('xl/charts/chart1.xml').series[0].values[0], 25)
})

for (const interruption of ['newer calculation', 'replacement session', 'concurrent chart edit']) {
  test(`actual live chart sync rejects stale reads after ${interruption}`, async () => {
    const f = await liveFixture()
    let resolve!: (v: unknown[][]) => void
    f.setRead(() => new Promise((r) => { resolve = r }))
    f.dirty(); const pending = f.sync.runChartDataSync(f.ctx)
    if (interruption === 'replacement session') f.ctx.lazyWorkbookRef.current = { ...f.state }
    else if (interruption === 'newer calculation') f.dirty()
    else f.state.editJournal.chartEdits.set('xl/charts/chart1.xml', { title: 'Changed' })
    // A second pass cannot overlap the pending range read.
    await f.sync.runChartDataSync(f.ctx)
    resolve([[20], [null], [0], [9]]); await pending
    assert.equal(f.state.editJournal.chartEdits.get('xl/charts/chart1.xml')?.series, undefined)
    assert.equal(f.refresh.length, 0)
    if (interruption !== 'replacement session') {
      assert.equal(f.ctx.chartSyncRef.current.dirty.size, 1)
      f.setRead(async () => [[30], [null], [0], [9]])
      await f.sync.runChartDataSync(f.ctx)
      assert.equal(f.state.editJournal.chartEdits.get('xl/charts/chart1.xml').series[0].values[0], 30)
    }
  })
}
