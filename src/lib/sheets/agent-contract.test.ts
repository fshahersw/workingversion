import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
// Match Vite's Office-scoped resolver, not the main platform's Zod 3 runtime.
import { z } from 'zod4'
import { workbookOperationToolSchema, verifyStructuralFormulaErrors } from './agent-contract.ts'
import { localOfficeCapabilities } from '../office/local-capabilities.server.ts'

// Execute the actual parser/tool module, replacing only imported browser helpers.
let moduleNumber = 0
async function actualModule(relative: string, imports: Record<string, unknown>) {
  const name = `__sheetsAgentContract${moduleNumber++}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[name] = imports
  try {
    const source = await readFile(new URL(`../../office/sheets/src/${relative}`, import.meta.url), 'utf8')
    const code = (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code
      .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
    const injected = `const { ${Object.keys(imports).join(', ')} } = globalThis.${name};\n`
    return await import(`data:text/javascript;base64,${Buffer.from(injected + code).toString('base64')}`)
  } finally { delete globals[name] }
}
const dsl = await actualModule('domain/workbook-dsl.ts', { z, ADDABLE_SHAPE_TYPES: ['rect'] })
const tools = await actualModule('renderer/ai/tools.ts', {
  z, workbookOperationSchema: dsl.workbookOperationSchema,
  workbookOperationToolSchema, verifyStructuralFormulaErrors,
  guideCatalogSummary: () => '', t: (key: string) => key,
})
const editTool = tools.WORKBOOK_TOOLS.find((tool: { name: string }) => tool.name === 'propose_operations')
const alternatives = editTool.inputSchema.properties.operations.items.anyOf as any[]
const operation = (name: string) => alternatives.find((schema) => schema.properties.op.enum.includes(name))

test('real model schema requires exact op and typed creation/financial/chart fields from the live DSL', () => {
  const names = alternatives.flatMap((schema) => schema.properties.op.enum)
  assert.deepEqual(new Set(names), new Set(dsl.workbookOperationSchema.options.map((schema: any) => schema.shape.op.value)))
  assert.equal(new Set(names).size, names.length)
  for (const alternative of alternatives) assert.ok(alternative.required.includes('op'))
  assert.deepEqual(operation('add_chart').required, ['op', 'sheetId', 'chartType', 'dataRange'])
  assert.deepEqual(operation('format_range').required, ['op', 'sheetId', 'range', 'format'])
  assert.equal(operation('format_range').properties.format.properties.fontSize.anyOf[0].type, 'number')
  assert.equal(operation('set_range').properties.values.items.items.anyOf[1].type, 'number')
  assert.equal(operation('set_range').properties.values.maxItems, 500)
  assert.equal(operation('set_formula').properties.formula.maxLength, 8192)
  assert.ok(!operation('finish_table').required.includes('headerRows'))
  assert.ok(!operation('finish_table').required.includes('verticalAlign'))
  assert.ok(JSON.stringify(editTool.inputSchema).length < 20_000, 'tool contract must remain bounded')
})

test('actual financial operations parse while hallucinated discriminator and invalid chart fields fail before mutation', async () => {
  for (const input of [
    { op: 'add_sheet', name: 'Synthetic Summary' },
    { op: 'set_range', sheetId: 'actual-id', start: 'A1', values: [['Quarter', 'Revenue'], ['Q1', 100]] },
    { op: 'set_formula', sheetId: 'actual-id', address: 'C2', formula: '=B2*0.2' },
    { op: 'format_range', sheetId: 'actual-id', range: 'B2:C2', format: { numberFormat: '#,##0.00', fontColor: '#172E4C' } },
    { op: 'add_chart', sheetId: 'actual-id', chartType: 'line', dataRange: 'A1:C5' },
  ]) assert.ok(dsl.workbookOperationSchema.safeParse(input).success)
  let called = false
  for (const input of [
    { type: 'add_chart', sheetId: 'actual-id', dataRange: 'A1:C5' },
    { op: 'add_chart', sheetId: 'actual-id', chartType: 'financial', dataRange: 'A1:C5' },
  ]) {
    const result = await tools.executeWorkbookTool({ name: 'propose_operations', input: { operations: [input], summary: 'Chart' } }, {
      proposeOperations: () => { called = true },
    })
    assert.equal(result.isError, true)
    assert.equal(result.mutated, false)
  }
  assert.equal(called, false)
})

const clean = () => ({ matches: [], incompleteSheets: [], truncated: false })
test('formula verification never calls failed, indexing-incomplete, or truncated scans clean', async () => {
  for (const scan of [
    () => ({ ...clean(), error: 'unavailable' }),
    () => { throw new Error('worker stopped') },
    () => ({ ...clean(), incompleteSheets: ['Summary'] }),
    () => ({ ...clean(), truncated: true }),
  ]) {
    const output = await verifyStructuralFormulaErrors(['summary'], scan)
    assert.match(output, /verification INCOMPLETE/)
    assert.doesNotMatch(output, /no formula error/)
    assert.match(output, /edits applied/)
  }
})

test('partial scans preserve detected cross-sheet formula errors and verification limitations', async () => {
  const output = await verifyStructuralFormulaErrors(['source', 'summary'], (id) => id === 'source'
    ? { ...clean(), error: 'indexing failed' }
    : { ...clean(), matches: [{ sheetName: 'Summary', address: 'B2', value: '#REF!' }] })
  assert.match(output, /Summary!B2 = #REF!/)
  assert.match(output, /verification INCOMPLETE/)
  assert.doesNotMatch(output, /no formula error/)
})

test('completed scans state their scope and do not certify business calculations', async () => {
  const scanned: string[] = []
  const output = await verifyStructuralFormulaErrors(['a', 'a', 'b'], (id) => { scanned.push(id); return clean() })
  assert.deepEqual(scanned, ['a', 'b'])
  assert.match(output, /no formula error values found/)
  assert.match(output, /does not verify business calculations/)
})

test('actual rename tool checks surviving sheets for dependent errors and returns applied-but-incomplete accurately', async () => {
  const scanned: string[] = []
  const result = await tools.executeWorkbookTool({ name: 'propose_operations', input: {
    operations: [{ op: 'rename_sheet', sheetId: 'source', name: 'Inputs' }], summary: 'Rename source',
  } }, {
    getActiveSheetInfo: () => ({ sheets: [{ id: 'source', name: 'Inputs' }, { id: 'summary', name: 'Summary' }] }),
    proposeOperations: () => ({ ok: true, plan: {
      warnings: [], cellChanges: [], formatChanges: [], structuralChanges: [],
      sheetRenames: [{ sheetId: 'source', before: 'Source', after: 'Inputs' }],
    }, applied: Promise.resolve({ ok: true }) }),
    findCells: ({ sheetId }: { sheetId: string }) => {
      scanned.push(sheetId)
      return sheetId === 'summary' ? { ...clean(), error: 'not loaded' } : clean()
    },
  })
  assert.deepEqual(scanned, ['source', 'summary'])
  assert.equal(result.mutated, true)
  assert.match(result.output, /Auto-applied 1 change/)
  assert.match(result.output, /verification INCOMPLETE/)
  assert.doesNotMatch(result.output, /no formula error/)
})

test('a post-mutation formula read failure preserves the applied outcome instead of rejecting the tool', async () => {
  const result = await tools.executeWorkbookTool({ name: 'propose_operations', input: {
    operations: [{ op: 'set_formula', sheetId: 'summary', address: 'B2', formula: '=SUM(B3:B5)' }], summary: 'Compute total',
  } }, {
    getActiveSheetInfo: () => ({ sheets: [{ id: 'summary', name: 'Summary' }] }),
    proposeOperations: () => ({ ok: true, plan: {
      warnings: [], formatChanges: [], structuralChanges: [], sheetRenames: [],
      cellChanges: [{ sheetId: 'summary', address: 'B2', before: { value: null }, after: { formula: '=SUM(B3:B5)', value: null } }],
    }, applied: Promise.resolve({ ok: true }) }),
    readCells: () => { throw new Error('recalculation unavailable') },
  })
  assert.equal(result.mutated, true)
  assert.match(result.output, /Auto-applied 1 change/)
  assert.match(result.output, /Formula verification INCOMPLETE/)
  assert.match(result.output, /recalculation unavailable/)
})

test('local Sheets exports keep the actual native type contract and dispatch worksheet exports without authored content', async () => {
  const original = { system: 'Keep the native workbook.', tools: tools.WORKBOOK_TOOLS }
  const local = localOfficeCapabilities(original, {
    LOCAL_SYNTHETIC_MODE: '1', NODE_ENV: 'development', OFFICE_LOCAL_PROVIDER: 'fireworks',
  })
  const exporter = local.tools.find((entry: { name: string }) => entry.name === 'create_document')!
  const fields = exporter.inputSchema.properties as Record<string, any>
  assert.deepEqual(fields.type.enum, ['xlsx', 'csv'])
  assert.equal('kind' in fields, false)
  assert.equal('content' in fields, false)
  assert.ok(fields.sheetId)
  assert.equal(exporter.inputSchema.additionalProperties, false)
  assert.match(exporter.description, /values-only/)
  assert.equal(localOfficeCapabilities(original, { NODE_ENV: 'production' }), original)
  for (const type of fields.type.enum) {
    let dispatched: unknown
    const result = await tools.executeWorkbookTool({ name: exporter.name, input: {
      type, sheetId: 'summary-id', title: 'Synthetic summary',
    } }, {
      getActiveSheetInfo: () => ({ sheets: [{ id: 'summary-id', name: 'Summary' }] }),
      createDocument: async (request: unknown) => {
        dispatched = request
        return { ok: true, name: `Synthetic summary.${type}`, sheetName: 'Summary', hadFormulas: true }
      },
    })
    assert.deepEqual(dispatched, { type, sheetId: 'summary-id', title: 'Synthetic summary' })
    assert.equal(result.isError, undefined)
    assert.match(result.output, /computed values only/)
  }
})

test('partial apply errors preserve the mutation flag needed for failure recovery', async () => {
  for (const partiallyApplied of [true, false]) {
    const result = await tools.executeWorkbookTool({ name: 'propose_operations', input: {
      operations: [{ op: 'set_cell', sheetId: 'summary', address: 'A1', value: 'Synthetic example' }],
      summary: 'Write heading',
    } }, {
      proposeOperations: () => ({ ok: true, plan: {}, applied: Promise.resolve({
        ok: false, reason: 'second operation failed', partiallyApplied,
      }) }),
    })
    assert.equal(result.isError, true)
    assert.equal(result.mutated, partiallyApplied)
    assert.match(result.output, partiallyApplied ? /MID-BATCH.*already committed/ : /workbook is UNCHANGED/)
  }
})

test('malformed operation wrappers receive bounded field/type guidance without coercion or data echoes', async () => {
  const secretCell = 'private-cell-value-must-not-be-echoed'
  let proposed = 0
  const inputs = [
    { operations: JSON.stringify([{ op: 'set_cell', sheetId: 's1', address: 'A1', value: secretCell }]), summary: 'Write' },
    { operations: '[{"values":[[1]]]}]', summary: secretCell },
    { ops: [{ value: secretCell }], summary: 'Write' },
    { operations: [], summary: 'Write' },
    { operations: null, summary: 'Write' },
    { operations: { value: secretCell }, summary: 'Write' },
    { ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}_${'x'.repeat(200)}`, secretCell])), operations: false },
  ]
  for (const input of inputs) {
    const result = await tools.executeWorkbookTool({ name: 'propose_operations', input }, {
      proposeOperations: () => { proposed++; throw new Error('Invalid wrapper must never execute') },
    })
    assert.equal(result.isError, true)
    assert.equal(result.mutated, false)
    assert.match(result.output, /operations must be a non-empty array/)
    assert.match(result.output, /top-level fields:/)
    assert.match(result.output, /No changes were applied/)
    assert.match(result.output, /not quoted JSON or code/)
    assert.match(result.output, /"summary":"Describe this batch","operations":\[/)
    assert.doesNotMatch(result.output, new RegExp(secretCell))
    assert.ok(result.output.length < 1100, 'diagnostic stays bounded even with many long field names')
  }
  assert.equal(proposed, 0, 'even valid JSON inside a string is rejected, never auto-unwrapped')
})
