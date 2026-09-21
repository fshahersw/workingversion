import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
import ts from 'typescript'

let moduleNumber = 0
async function moduleFrom(source: string, imports: Record<string, unknown> = {}) {
  const name = `__chartContext${moduleNumber++}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[name] = imports
  try {
    const code = (await transform(source, { loader: 'ts', format: 'esm' })).code
      .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
    return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(imports).join(',')}} = globalThis.${name};\n${code}`).toString('base64')}`)
  } finally { delete globals[name] }
}
const source = (file: string) => readFile(new URL(`../../office/sheets/src/${file}`, import.meta.url), 'utf8')
const address = await moduleFrom(await source('domain/cell-address.ts'))
const cache = await moduleFrom(await source('domain/chart-cache.ts'))
const chart = await moduleFrom(await source('domain/chart-visual.ts'), { ...address, ...cache })
const readers = await moduleFrom(await source('renderer/ai/workbook-readers.ts'), {
  ...address, ...chart, MAX_PATCH_ENTRY_BYTES: 64_000_000, lazySheetScreenExtent: () => ({ rows: 25, columns: 6 }),
})
const toolSource = await source('renderer/ai/tools.ts')
const ast = ts.createSourceFile('tools.ts', toolSource, ts.ScriptTarget.Latest, true)
const builder = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildWorkbookContext')!
const tools = await moduleFrom(builder.getText(ast), address)
const series = { name: 'Revenue', values: [10, 20], categories: ['1', '2'], valuesRef: "'Annual'!B5:C5" }
const visual = (id: string, sheetId = 'main') => ({ id, kind: 'chart', sheetId, chartPath: `xl/charts/${id}.xml`,
  chart: { title: `Old ${id}`, chartTypes: ['barChart'], series: [structuredClone(series)] } })

function fixture() {
  const worksheets = ['main', 'removed'].map(id => ({ getSheetId: () => id, getSheetName: () => id === 'main' ? 'Annual' : 'Removed', getMergedRanges: () => [] }))
  const workbook = { getActiveSheet: () => worksheets[0], getActiveRange: () => null, getSheets: () => worksheets,
    getSheetBySheetId: (id: string) => worksheets.find(sheet => sheet.getSheetId() === id) }
  const state: any = { formulaMode: true, loadedRanges: new Map(), sheetProtections: new Map(),
    file: { sheets: [{ id: 'main', name: 'Annual', pivotTables: [], pivotRanges: [] }],
      visuals: [visual('deleted'), visual('current'), visual('removed-sheet', 'removed'), visual('orphan', 'missing')] },
    editJournal: { visualAdds: [{ ...visual('added'), chartPath: undefined }],
      visualEdits: new Map([['deleted', { remove: true }]]), sheets: { removed: new Set(['removed']), hidden: new Map() },
      sheetProtection: new Map(), pageSetup: new Map(),
      chartEdits: new Map([['xl/charts/current.xml', { title: 'Current annual revenue', chartType: 'line',
        series: [{ index: 0, name: 'Correct revenue', values: [30, 40], categories: ['2021', '2022'],
          valuesRef: "'Annual'!B8:C8", categoriesRef: "'Annual'!B4:C4" }] }]]) },
  }
  const ctx: any = { univerRef: { current: { univerAPI: { getActiveWorkbook: () => workbook } } }, lazyWorkbookRef: { current: state }, adapterRef: { current: {} } }
  const info = () => readers.getActiveSheetInfo(ctx)
  const output = () => tools.buildWorkbookContext({ getActiveSheetInfo: info })
  return { ctx, state, info, output }
}

test('actual context excludes deleted charts/removed or missing sheets and reports pending chart state plus new charts', () => {
  const f = fixture(), info = f.info()
  assert.equal(info.chartCount, 2)
  assert.deepEqual(info.charts.map((entry: any) => entry.path), ['xl/charts/current.xml', 'added'])
  const current = info.charts[0]
  assert.equal(current.title, 'Current annual revenue'); assert.equal(current.types, 'lineChart')
  assert.equal(current.seriesCount, 1)
  assert.deepEqual(current.series[0], { index: 0, name: 'Correct revenue', valueCount: 2, categoryCount: 2,
    categorySample: ['2021', '2022'], valuesRef: "'Annual'!B8:C8", categoriesRef: "'Annual'!B4:C4" })
  const output = f.output()
  assert.match(output, /Current charts in the workbook: 2/)
  assert.match(output, /categories='Annual'!B4:C4/)
  assert.doesNotMatch(output, /Old current|deleted\.xml|removed-sheet\.xml|orphan\.xml/)
  // Re-reading after another removal must describe absence immediately.
  f.state.editJournal.visualEdits.set('current', { remove: true })
  f.state.editJournal.visualAdds = []
  assert.match(f.output(), /Current charts in the workbook: 0/)
})

test('full series replacement and index patches appear together in effective context', () => {
  const f = fixture()
  f.state.editJournal.chartEdits.set('xl/charts/current.xml', {
    seriesSet: [series, { ...series, name: 'Margin' }], series: [{ index: 1, name: 'Net margin', categories: ['2021', '2022'], categoriesRef: "'Annual'!B4:C4" }],
  })
  const current = f.info().charts[0]
  assert.equal(current.seriesCount, 2)
  assert.equal(current.series[1].name, 'Net margin')
  assert.equal(current.series[1].categoriesRef, "'Annual'!B4:C4")
})

test('actual chart context reports pending primary and secondary formats without changing original axis titles', () => {
  const f = fixture()
  const current = f.state.file.visuals.find((entry: any) => entry.id === 'current')
  current.chart.yAxis = { title: 'USD millions', numFmt: 'General', majorGridlines: true, hidden: false, reversed: false }
  current.chart.secondaryYAxis = { title: 'Net margin (%)', numFmt: 'General', majorGridlines: false, hidden: false, reversed: false }
  current.chart.axisTitles = { category: 'Year', value: 'USD millions' }
  f.state.editJournal.chartEdits.set('xl/charts/current.xml', { valueAxisFormats: { primary: '#,##0', secondary: '0.0%' } })
  const info = f.info().charts[0]
  assert.deepEqual(info.valueAxisFormats, { primary: '#,##0', secondary: '0.0%' })
  assert.match(f.output(), /Value-axis number formats:.*primary.*#,##0.*secondary.*0\.0%/)
  const effective = chart.applyChartStateEdit(current.chart, f.state.editJournal.chartEdits.get('xl/charts/current.xml'))
  assert.equal(effective.yAxis.title, 'USD millions')
  assert.equal(effective.secondaryYAxis.title, 'Net margin (%)')
  assert.deepEqual(effective.axisTitles, { category: 'Year', value: 'USD millions' })
  assert.equal(current.chart.yAxis.numFmt, 'General')
})

test('chart context bounds details without hiding the true counts or silently claiming complete inventory', () => {
  const f = fixture()
  f.state.editJournal.visualAdds = []; f.state.editJournal.visualEdits.clear(); f.state.editJournal.chartEdits.clear()
  f.state.file.visuals = Array.from({ length: 100 }, (_, index) => ({ ...visual(`many${index}`), chart: {
    title: 'T'.repeat(1000), chartTypes: ['lineChart'], series: Array.from({ length: 50 }, () => ({
      name: 'N'.repeat(1000), values: Array(1000).fill(5), categories: Array(1000).fill('C'.repeat(1000)), valuesRef: 'R'.repeat(2000), categoriesRef: 'Q'.repeat(2000),
    })),
  } }))
  const info = f.info()
  assert.equal(info.chartCount, 100); assert.equal(info.charts.length, 32)
  assert.equal(info.charts[0].seriesCount, 50); assert.equal(info.charts[0].series.length, 8)
  assert.equal(info.charts[0].series[0].categorySample.length, 3)
  assert.equal(info.charts[0].series[0].categorySample[0].length, 64)
  const output = f.output()
  assert.ok(output.length < 32_000, String(output.length))
  assert.match(output, /showing 32 of 100/); assert.match(output, /Additional chart series details omitted/)
})

test('actual read_sheet_features excludes deleted non-chart visuals and visuals on removed sheets', () => {
  const f = fixture()
  const shape = (id: string) => ({ id, sheetId: 'main', kind: 'shape', shapeType: 'rect', text: id, anchor: { fromRow: 0, fromColumn: 0 } })
  f.state.file.visuals.push(shape('deleted-shape'), shape('visible-shape'))
  f.state.editJournal.visualEdits.set('deleted-shape', { remove: true })
  let output = readers.readSheetFeatures(f.ctx)
  assert.match(output, /Shapes\/images: 1/); assert.match(output, /visible-shape/); assert.doesNotMatch(output, /deleted-shape/)
  f.state.editJournal.sheets.removed.add('main')
  output = readers.readSheetFeatures(f.ctx)
  assert.doesNotMatch(output, /visible-shape|deleted-shape/)
})
