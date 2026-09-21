import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { z } from 'zod4'
import { workbookOperationToolSchema, verifyStructuralFormulaErrors } from '../sheets/agent-contract'
import * as saveCommit from '../../office/sheets/src/renderer/save-commit-lock'

// Exercise the production save/read modules while replacing their browser and
// native transports. Formula events and raw cell data model the public facade.
let moduleNumber = 0
async function actualModule(relative: string, imports: Record<string, unknown> = {}) {
  const name = `__sheetsSaveRegression${moduleNumber++}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[name] = imports
  try {
    const source = await readFile(new URL(`../../office/sheets/src/${relative}`, import.meta.url), 'utf8')
    const code = (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code
      .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
    const injected = `const { ${Object.keys(imports).join(', ')} } = globalThis.${name};\n`
    return await import(`data:text/javascript;base64,${Buffer.from(injected + code + `\n//# sourceURL=${relative}`).toString('base64')}`)
  } finally { delete globals[name] }
}
const formulaModule = await actualModule('renderer/save-formula-values.ts', {
  FormulaExecutedStateType: { INITIAL: 0, STOP_EXECUTION: 1, NOT_EXECUTED: 2, SUCCESS: 3 },
})
const addressModule = await actualModule('domain/cell-address.ts')
const cacheModule = await actualModule('domain/chart-cache.ts')
const chartModule = await actualModule('domain/chart-visual.ts', { ...addressModule, ...cacheModule })
const saveChartModule = await actualModule('renderer/save-chart-values.ts', {
  ...addressModule, ...chartModule, ...cacheModule, CHART_CATEGORY_WIRE_MAX: 1024,
})
const empty = () => []
const saveModule = await actualModule('renderer/save-actions.ts', {
  ...formulaModule, ...saveChartModule, ...saveCommit,
  isManualCalculation: (runtime: { manual?: boolean }) => runtime?.manual === true,
  isSheetRemoved: (journal: any, id: string) => journal.sheets.removed.has(id),
  toSaveEdits: (journal: any) => [...journal.cells].flatMap(([sheetId, cells]: any) =>
    [...cells.values()].map((cell: any) => ({ sheetId, ...cell }))),
  toSaveChartEdits: (journal: any) => [...journal.chartEdits].map(([chartPath, edit]) => structuredClone({ chartPath, ...edit })),
  toSaveVisualAdds: (journal: any) => structuredClone(journal.visualAdds),
  ...Object.fromEntries(['toSaveBulkConstantFills', 'toSaveHyperlinkEdits', 'toSavePageSetupStates',
    'toSavePivotAdds', 'toSaveSheetOps', 'toSaveSparklineAdds', 'toSaveStructuralOps', 'toSaveTableAdds',
    'toSaveVisualEdits', 'collectCfStates', 'collectDvStates', 'collectFilterStates',
    'collectNoteStates'].map(name => [name, empty])),
  collectDefinedNamesState: () => null, getScrollAnchor: () => null,
  stageEditsForSave: async (_api: unknown, _session: unknown, edits: unknown) => ({ edits }),
  abortStagedEditsTransfer: async () => undefined,
  t: (key: string) => key, showToast: () => undefined,
  captureUndoCarry: () => null, stashUndoCarry: () => undefined, hasPendingUndoCarry: () => false,
})

function fixture() {
  const raw = new Map<string, any>([['3:1', { f: '=SUM(B2:B3)', v: 0, t: 2 }]])
  const journal = {
    cells: new Map([['sheet-1', new Map([['3:1', { row: 3, column: 1, hasValue: true, value: null, formula: '=SUM(B2:B3)' }]])]]),
    bulkConstantFills: new Map(), structuralOps: new Map(),
    sheets: { added: new Map(), renamed: new Map(), removed: new Set() },
    sheetProtection: new Map(), pageSetup: new Map(), pivotCacheRefresh: new Set(), pivotRefreshUpdates: new Map(),
    workbookProtection: { desired: null }, protectedRangesDirty: new Set(), theme: {}, visualAdds: [] as any[],
    chartEdits: new Map<string, any>(), visualEdits: new Map<string, any>(),
  }
  const state = {
    file: { sessionId: 'local-session', sheets: [{ id: 'sheet-1', name: 'Sheet1', rowCount: 1, columnCount: 1 }], visuals: [] as any[] },
    formulaMode: true, flags: { preloadComplete: true }, editJournal: journal,
    recalc: { overlay: new Map(), timer: null, running: false, failures: 0 }, loadedRanges: new Map(),
  }
  const startListeners = new Set<Function>(), endListeners = new Set<Function>()
  let resolve!: () => void, reject!: (error: Error) => void
  let triggered = false, manual = false
  const formula = {
    calculationStart: (fn: Function) => { startListeners.add(fn); return { dispose: () => startListeners.delete(fn) } },
    calculationEnd: (fn: Function) => { endListeners.add(fn); return { dispose: () => endListeners.delete(fn) } },
    onCalculationResultApplied: () => new Promise<void>((res, rej) => { resolve = res; reject = rej }),
    executeCalculation: () => { triggered = true; startListeners.forEach(fn => fn(true)) },
  }
  const matrix = { forValue: (fn: Function) => raw.forEach((cell, key) => fn(...key.split(':').map(Number), cell)),
    getValue: (row: number, col: number) => raw.get(`${row}:${col}`) }
  const sheet = { getSheetId: () => 'sheet-1', getSheetName: () => 'Sheet1', getSheet: () => ({ getCellMatrix: () => matrix }), getMergedRanges: () => [] }
  const workbook = { getId: () => 'workbook-1', getSheets: () => [sheet], getActiveSheet: () => sheet,
    getSheetBySheetId: () => sheet, getActiveRange: () => null }
  const runtime = { get manual() { return manual }, univerAPI: { getActiveWorkbook: () => workbook, getFormula: () => formula } }
  const messages: string[] = [], saved: any[] = []
  const ctx = { univerRef: { current: runtime }, lazyWorkbookRef: { current: state }, setMessage: (message: string) => messages.push(message),
    openLazyWorkbook: () => undefined, stashViewRestore: () => undefined }
  return { state, raw, ctx, runtime, saved, messages, get triggered() { return triggered }, setManual: () => { manual = true },
    listeners: () => startListeners.size + endListeners.size,
    finish: (status = 3) => { endListeners.forEach(fn => fn(status)); resolve() },
    timeout: () => reject(new Error('Calculation end timeout')),
  }
}
async function withSave(f: ReturnType<typeof fixture>, run: () => Promise<void>) {
  const globals = globalThis as unknown as Record<string, unknown>, previous = globals.window
  globals.window = { desktopApi: { saveWorkbookEdits: async (request: unknown) => {
    f.saved.push(request); return { canceled: false, file: { sha256: 'saved' } }
  } } }
  try { await run() } finally { globals.window = previous }
}

function chartFixture() {
  const f = fixture()
  f.raw.set('3:0', { v: 'Q1' })
  f.raw.set('3:1', { f: "='Inputs'!B2", v: 10, t: 2 })
  const workbook = f.runtime.univerAPI.getActiveWorkbook() as any
  const summary = workbook.getSheets()[0]
  const inputs = { ...summary, getSheetId: () => 'inputs', getSheetName: () => 'Inputs',
    getSheet: () => ({ getCellMatrix: () => ({ forValue: () => {}, getValue: () => ({ v: 25, t: 2 }) }) }) }
  workbook.getSheets = () => [summary, inputs]
  workbook.getSheetBySheetId = (id: string) => id === 'sheet-1' ? summary : id === 'inputs' ? inputs : undefined
  f.state.file.sheets.push({ id: 'inputs', name: 'Inputs', rowCount: 2, columnCount: 2 })
  const series = { name: 'Revenue', values: [10], categories: ['Q1'], valuesRef: "'Sheet1'!$B$4", categoriesRef: "'Sheet1'!$A$4", color: '#172E4C' }
  f.state.file.visuals.push({ id: 'original', kind: 'chart', sheetId: 'sheet-1', chartPath: 'xl/charts/chart1.xml',
    chart: { chartTypes: ['lineChart'], title: 'Original', series: [structuredClone(series)] } })
  f.state.editJournal.chartEdits.set('xl/charts/chart1.xml', { title: 'Preserved title', legend: 'bottom', seriesColors: { '0': '#172E4C' } })
  f.state.editJournal.visualAdds.push({ sheetId: 'sheet-1', anchor: { fromRow: 5, fromColumn: 3, toRow: 15, toColumn: 10 },
    chart: { chartType: 'line', title: 'New revenue chart', legend: 'bottom', series: [structuredClone(series)] } })
  return f
}

for (const fails of [false, true]) {
  test(`actual save holds the commit lock through request/reopen and releases after ${fails ? 'failure' : 'success'}`, async () => {
    const f = fixture(); f.setManual()
    const globals = globalThis as unknown as Record<string, unknown>, previous = globals.window
    let release!: () => void
    let entered = false, reopened = false
    globals.window = { desktopApi: { saveWorkbookEdits: async () => {
      entered = true
      assert.equal(saveCommit.isWorkbookSaveCommitting(f.state), true)
      await new Promise<void>(resolve => { release = resolve })
      if (fails) throw new Error('synthetic save failure')
      return { canceled: false, file: { sha256: 'saved' } }
    } } }
    f.ctx.openLazyWorkbook = () => { reopened = true; assert.equal(saveCommit.isWorkbookSaveCommitting(f.state), true) }
    try {
      const saving = saveModule.handleSave(f.ctx, 'save', true)
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(entered, true)
      await saveModule.handleSave(f.ctx, 'save', true) // concurrent save does not dispatch
      assert.equal(saveCommit.isWorkbookSaveCommitting(f.state), true)
      release(); await saving
      assert.equal(reopened, !fails)
      assert.equal(saveCommit.isWorkbookSaveCommitting(f.state), false)
    } finally { globals.window = previous }
  })
}

test('two saves already preparing cannot both enter the native commit window', async () => {
  const f = fixture(); f.setManual()
  const globals = globalThis as unknown as Record<string, unknown>, previous = globals.window
  let release!: () => void, calls = 0
  globals.window = { desktopApi: { saveWorkbookEdits: async () => {
    calls++
    await new Promise<void>(resolve => { release = resolve })
    return { canceled: false, file: { sha256: 'saved' } }
  } } }
  try {
    const first = saveModule.handleSave(f.ctx, 'save', true)
    const second = saveModule.handleSave(f.ctx, 'save', true)
    await new Promise(resolve => setTimeout(resolve, 0))
    await second
    assert.equal(calls, 1)
    release(); await first
    assert.equal(saveCommit.isWorkbookSaveCommitting(f.state), false)
  } finally { globals.window = previous }
})

test('actual save refreshes existing and new charts from post-calculation cross-sheet formula values without changing journal or styles', async () => {
  const f = chartFixture()
  const before = formulaModule.saveJournalSnapshot(f.state)
  await withSave(f, async () => {
    const saving = saveModule.handleSave(f.ctx, 'save', true)
    assert.equal(f.saved.length, 0)
    f.raw.get('3:1').v = 25
    f.raw.get('3:0').v = 'Q2'
    f.finish(); await saving
    assert.equal(f.saved.length, 1, f.messages.join('; '))
    const saved = f.saved[0]
    assert.equal(saved.formulaValues[0].value, 25)
    assert.deepEqual(saved.chartEdits[0], {
      chartPath: 'xl/charts/chart1.xml', title: 'Preserved title', legend: 'bottom', seriesColors: { '0': '#172E4C' },
      series: [{ index: 0, values: [25], blanks: [], categories: ['Q2'] }],
    })
    assert.deepEqual(saved.visualAdditions[0].chart.series[0], {
      name: 'Revenue', values: [25], blanks: [], categories: ['Q2'], valuesRef: "'Sheet1'!$B$4", categoriesRef: "'Sheet1'!$A$4", color: '#172E4C',
    })
    assert.equal(saved.visualAdditions[0].chart.legend, 'bottom')
    assert.equal(formulaModule.saveJournalSnapshot(f.state), before)
  })
})

for (const fault of ['unresolved formula', 'read failure', 'concurrent chart edit']) {
  test(`actual save does not dispatch a chart cache after ${fault}`, async () => {
    const f = chartFixture()
    await withSave(f, async () => {
      const saving = saveModule.handleSave(f.ctx, 'save', true)
      if (fault === 'unresolved formula') f.raw.get('3:1').v = '#REF!'
      else if (fault === 'concurrent chart edit') f.state.editJournal.chartEdits.get('xl/charts/chart1.xml').title = 'Changed during save'
      else {
        // Formula B4 reads successfully; only the later chart-category read
        // fails, so this covers failure after calculation has completed.
        const matrix = f.runtime.univerAPI.getActiveWorkbook().getSheets()[0].getSheet().getCellMatrix()
        const read = matrix.getValue.bind(matrix)
        matrix.getValue = (row: number, column: number) => {
          if (row === 3 && column === 0) throw new Error('raw chart source unavailable')
          return read(row, column)
        }
      }
      f.finish(); await saving
      assert.equal(f.saved.length, 0)
      assert.match(f.messages.join(' '), /unresolved|unavailable|changed/)
    })
  })
}

test('save chart refresh honors repointed pending refs and preserves literal/cache-less/unsupported chart payloads', () => {
  const f = chartFixture()
  f.raw.set('4:1', { v: 35, t: 2 })
  const pending = [{ chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, valuesRef: "'Sheet1'!$B$5", values: [0] }] }]
  const literal = { sheetId: 'sheet-1', chart: { chartType: 'line', title: 'Literal', series: [{ name: 'Fixed', values: [99], categories: ['X'] }] } }
  const result = saveChartModule.synchronizeSavedChartCaches(f.runtime, f.state, pending, [literal], false)
  assert.deepEqual(result.chartEdits[0].series[0], { index: 0, valuesRef: "'Sheet1'!$B$5", values: [35], blanks: [] })
  assert.deepEqual(result.visualAdditions[0], literal)
  f.state.file.visuals[0].chart.series[0].values = []
  assert.deepEqual(saveChartModule.synchronizeSavedChartCaches(f.runtime, f.state, [], [], false).chartEdits, [])
  f.state.file.visuals[0].chart.chartTypes = ['bubbleChart']
  assert.deepEqual(saveChartModule.synchronizeSavedChartCaches(f.runtime, f.state, [], [], false).chartEdits, [])
  assert.deepEqual(saveChartModule.synchronizeSavedChartCaches(f.runtime, f.state, pending, [literal], true), { chartEdits: pending, visualAdditions: [literal] })
})

test('actual native chart writer refreshes cache without changing references, number format, or series styling', async () => {
  const native = await actualModule('gateway/xlsx-chart.ts', cacheModule)
  const xml = '<c:chart><c:lineChart><c:ser><c:idx val="0"/><c:order val="0"/><c:spPr><a:solidFill><a:srgbClr val="172E4C"/></a:solidFill></c:spPr><c:val><c:numRef><c:f>\'Sheet1\'!$B$4</c:f><c:numCache><c:formatCode>0.00%</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>10</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:lineChart></c:chart>'
  const output = native.applyChartEdit(xml, { chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, values: [25] }] })
  assert.ok(output.includes('<c:f>\'Sheet1\'!$B$4</c:f>'))
  assert.ok(output.includes('<c:formatCode>0.00%</c:formatCode>'))
  assert.ok(output.includes('<a:srgbClr val="172E4C"/>'))
  assert.ok(output.includes('<c:v>25</c:v>'))
  assert.ok(!output.includes('<c:v>10</c:v>'))
})

test('actual save keeps blank chart points sparse, retains real zero, and leaves the live journal unchanged', async () => {
  const f = chartFixture()
  for (const item of [f.state.file.visuals[0].chart.series[0], f.state.editJournal.visualAdds[0].chart.series[0]]) {
    item.valuesRef = "'Sheet1'!$B$4:$B$7"
    item.values = [10, 99, 88, 77]
  }
  f.raw.set('4:1', { v: null }); f.raw.set('5:1', { v: 0 }); f.raw.set('6:1', { v: 9 })
  const before = formulaModule.saveJournalSnapshot(f.state)
  await withSave(f, async () => {
    const saving = saveModule.handleSave(f.ctx, 'save', true)
    f.raw.get('3:1').v = 25
    f.finish(); await saving
    assert.equal(f.saved.length, 1, f.messages.join('; '))
    for (const entry of [f.saved[0].chartEdits[0].series[0], f.saved[0].visualAdditions[0].chart.series[0]]) {
      assert.deepEqual(entry.values, [25, 0, 0, 9]); assert.deepEqual(entry.blanks, [1])
    }
    assert.equal(f.saved[0].formulaValues[0].value, 25)
    assert.equal(formulaModule.saveJournalSnapshot(f.state), before)
  })
})

test('actual save preserves named, external, 3D, malformed, and oversized chart refs instead of blocking unrelated edits', async () => {
  for (const ref of ['QuarterRevenue', "'Sheet1'!Revenue", "'[Book.xlsx]Sheet1'!$B$4", "'Sheet1:Inputs'!$B$4", "'Sheet1'!$B$0", "'Sheet1'!$B$1:$B$1001"]) {
    const f = chartFixture()
    f.state.file.visuals[0].chart.series[0].valuesRef = ref
    f.state.editJournal.visualAdds[0].chart.series[0].valuesRef = ref
    await withSave(f, async () => {
      const saving = saveModule.handleSave(f.ctx, 'save', true)
      f.raw.get('3:1').v = 25
      f.finish(); await saving
      assert.equal(f.saved.length, 1, `${ref}: ${f.messages.join('; ')}`)
      assert.equal(f.saved[0].chartEdits[0].series, undefined)
      assert.equal(f.saved[0].visualAdditions[0].chart.series[0].valuesRef, ref)
      assert.deepEqual(f.saved[0].visualAdditions[0].chart.series[0].values, [10])
      assert.equal(f.saved[0].formulaValues[0].value, 25)
    })
  }
})

test('actual save waits for applied calculation and exports raw formula cache without replacing formula', async () => {
  const f = fixture()
  await withSave(f, async () => {
    const saving = saveModule.handleSave(f.ctx, 'save', true)
    assert.equal(f.triggered, true); assert.equal(f.saved.length, 0)
    f.raw.get('3:1').v = 25
    f.finish(); await saving
    assert.equal(f.saved.length, 1)
    assert.deepEqual(f.saved[0].formulaValues, [{ sheetId: 'sheet-1', row: 3, column: 1, value: 25 }])
    assert.equal(f.saved[0].edits[0].formula, '=SUM(B2:B3)')
    assert.equal(f.saved[0].edits[0].value, null)
    assert.equal(f.listeners(), 0)
  })
})

for (const reason of ['stopped', 'timeout', 'concurrent edit', 'session replaced']) {
  test(`actual save does not dispatch stale formula cache after ${reason}`, async () => {
    const f = fixture()
    await withSave(f, async () => {
      const saving = saveModule.handleSave(f.ctx, 'save', true)
      if (reason === 'timeout') f.timeout()
      else {
        if (reason === 'concurrent edit') f.state.editJournal.cells.get('sheet-1')!.set('3:1', { row: 3, column: 1, hasValue: true, value: null, formula: '=99' })
        if (reason === 'session replaced') f.ctx.lazyWorkbookRef.current = { ...f.state }
        f.finish(reason === 'stopped' ? 1 : 3)
      }
      await saving
      assert.equal(f.saved.length, 0); assert.equal(f.listeners(), 0)
      if (reason !== 'session replaced') assert.match(f.messages.join(' '), /calculation|Calculation|changed/)
    })
  })
}

test('formula cache preserves raw booleans and excludes unsupported, nonfinite and incomplete results', async () => {
  const f = fixture()
  f.raw.set('0:0', { f: '=TRUE()', v: 1, t: 3 })
  f.raw.set('0:1', { f: '=UNKNOWN()', v: '#NAME?' })
  f.raw.set('0:2', { f: '=1/0', v: Infinity })
  f.raw.set('0:3', { f: '=4', v: null })
  const result = formulaModule.collectLiveFormulaValues(f.runtime, f.state, () => true, false)
  f.finish()
  assert.deepEqual((await result).find((cell: any) => cell.row === 0), { sheetId: 'sheet-1', row: 0, column: 0, value: true })
  assert.equal((await result).length, 2)
  assert.deepEqual(await formulaModule.collectLiveFormulaValues(f.runtime, f.state, () => true, true), [])
  f.state.flags.preloadComplete = false
  assert.deepEqual(await formulaModule.collectLiveFormulaValues(f.runtime, f.state, () => true, false), [])
})

test('actual workbook context/read_range accepts new unsaved content and retains structural source extent', async () => {
  const transformModule = await actualModule('renderer/view-transform.ts')
  const stateModule = await actualModule('renderer/univer-state.ts', { ...transformModule, BorderType: {} })
  const addressModule = await actualModule('domain/cell-address.ts')
  const readers = await actualModule('renderer/ai/workbook-readers.ts', { ...addressModule, ...stateModule, MAX_PATCH_ENTRY_BYTES: 64_000_000 })
  const dsl = await actualModule('domain/workbook-dsl.ts', { z, ADDABLE_SHAPE_TYPES: ['rect'] })
  const tools = await actualModule('renderer/ai/tools.ts', { ...addressModule, z, workbookOperationSchema: dsl.workbookOperationSchema,
    workbookOperationToolSchema, verifyStructuralFormulaErrors, t: (key: string) => key, guideCatalogSummary: () => '' })
  const f = fixture()
  const context = () => readers.getActiveSheetInfo(f.ctx)
  assert.deepEqual(context().sheets[0], { id: 'sheet-1', name: 'Sheet1', rows: 4, columns: 2 })
  let reads = 0
  const result = await tools.executeWorkbookTool({ name: 'read_range', input: { range: 'A1:B4', sheetId: 'sheet-1' } }, {
    getActiveSheetInfo: context, readCells: () => { reads++; return { B4: { value: 25, formula: '=SUM(B2:B3)' } } },
    ensureRangeLoaded: async () => true,
  })
  assert.equal(reads, 1); assert.equal(result.isError, undefined)
  assert.match(result.output, /A1:B4/); assert.match(result.output, /25/)
  // Blank clears and format-only entries do not invent used rows.
  f.state.editJournal.cells.get('sheet-1')!.set('900:900', { row: 900, column: 900, hasValue: false, value: null } as any)
  assert.deepEqual(stateModule.lazySheetScreenExtent(f.state, 'sheet-1'), { rows: 4, columns: 2 })
  f.state.editJournal.bulkConstantFills.set('sheet-1', [{ endRow: 9, endColumn: 3, value: 0 }] as never)
  assert.deepEqual(stateModule.lazySheetScreenExtent(f.state, 'sheet-1'), { rows: 10, columns: 4 })
  f.state.file.sheets[0].rowCount = 20
  f.state.editJournal.structuralOps.set('sheet-1', [{ kind: 'remove-rows', index: 0, count: 2 }] as never)
  assert.equal(stateModule.lazySheetScreenExtent(f.state, 'sheet-1').rows, 18)
})
