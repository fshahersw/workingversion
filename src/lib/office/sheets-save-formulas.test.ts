import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { z } from 'zod'

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
const empty = () => []
const saveModule = await actualModule('renderer/save-actions.ts', {
  ...formulaModule,
  isManualCalculation: (runtime: { manual?: boolean }) => runtime?.manual === true,
  isSheetRemoved: (journal: any, id: string) => journal.sheets.removed.has(id),
  toSaveEdits: (journal: any) => [...journal.cells].flatMap(([sheetId, cells]: any) =>
    [...cells.values()].map((cell: any) => ({ sheetId, ...cell }))),
  ...Object.fromEntries(['toSaveChartEdits', 'toSaveBulkConstantFills', 'toSaveHyperlinkEdits', 'toSavePageSetupStates',
    'toSavePivotAdds', 'toSaveSheetOps', 'toSaveSparklineAdds', 'toSaveStructuralOps', 'toSaveTableAdds',
    'toSaveVisualAdds', 'toSaveVisualEdits', 'collectCfStates', 'collectDvStates', 'collectFilterStates',
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
    workbookProtection: { desired: null }, protectedRangesDirty: new Set(), theme: {}, visualAdds: [],
  }
  const state = {
    file: { sessionId: 'local-session', sheets: [{ id: 'sheet-1', name: 'Sheet1', rowCount: 1, columnCount: 1 }], visuals: [] },
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
  const tools = await actualModule('renderer/ai/tools.ts', { ...addressModule, z, workbookOperationSchema: z.any(), t: (key: string) => key, guideCatalogSummary: () => '' })
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
