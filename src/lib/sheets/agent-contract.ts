// Vite resolves the vendored Sheets DSL's `zod` import to zod4. This shared
// helper is outside that tree, so it must select the same runtime explicitly.
import { z } from 'zod4'

type JsonSchema = Record<string, unknown>

// Keep the common creation path explicit without sending the entire DSL and
// every guide on every model turn. Names and fields come from the live parser.
const EXPLICIT_OPERATIONS = new Set([
  'add_sheet', 'rename_sheet', 'set_cell', 'set_formula', 'set_range',
  'fill_range', 'copy_range', 'format_range', 'finish_table', 'merge_cells',
  'set_freeze', 'set_page_setup', 'add_chart', 'edit_chart',
])

/** Normalize canonical JSON Schema for provider tool guidance. Custom runtime
 * refinements still run on every call. Reject invented fields in model output
 * instead of inviting Zod's strip-unknown behavior to hide unsupported edits. */
function modelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelSchema)
  if (!value || typeof value !== 'object') return value
  const output = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema').map(([key, item]) => [key, modelSchema(item)]))
  if ('const' in output) { output.enum = [output.const]; delete output.const }
  if (output.type === 'object' && output.properties && output.additionalProperties === undefined) output.additionalProperties = false
  return output
}

// Structural typing also works in tsc, whose paths do not apply Vite's per-tree
// Zod alias. At runtime these are the Zod 4 schemas from workbook-dsl.ts.
export function workbookOperationToolSchema(options: readonly { shape: { op: { value: unknown } } }[]): JsonSchema {
  const explicit: JsonSchema[] = []
  const guided: string[] = []
  for (const option of options) {
    const op = option.shape.op.value as string
    if (EXPLICIT_OPERATIONS.has(op)) explicit.push(modelSchema(z.toJSONSchema(option as unknown as z.ZodType, { io: 'input' })) as JsonSchema)
    else guided.push(op)
  }
  return { anyOf: [...explicit, {
    type: 'object',
    properties: { op: { type: 'string', enum: guided } },
    required: ['op'],
    description: 'Other supported operations: load the matching guide for their exact required fields before calling. Use op, never type or action. Runtime validates all fields.',
  }] }
}

type FormulaScan = {
  matches: readonly { sheetName: string; address: string; value: unknown }[]
  truncated: boolean
  incompleteSheets: readonly string[]
  error?: string
}

/** A missing/partial scan cannot establish absence of formula errors. */
export async function verifyStructuralFormulaErrors(
  sheetIds: readonly string[],
  scan: (sheetId: string) => FormulaScan | Promise<FormulaScan>,
): Promise<string> {
  if (!sheetIds.length) return ''
  const found: string[] = []
  const incomplete: string[] = []
  let truncated = false
  for (const sheetId of new Set(sheetIds)) {
    try {
      const result = await scan(sheetId)
      if (result.error) { incomplete.push(`${sheetId}: ${result.error}`); continue }
      found.push(...result.matches.map((cell) => `${cell.sheetName}!${cell.address} = ${String(cell.value)}`))
      if (result.incompleteSheets.length) incomplete.push(`${sheetId}: indexing incomplete`)
      if (result.truncated) { truncated = true; incomplete.push(`${sheetId}: scan limit reached`) }
    } catch (error) {
      incomplete.push(`${sheetId}: ${error instanceof Error ? error.message : 'scan failed'}`)
    }
  }
  const lines: string[] = []
  if (found.length) lines.push(
    `⚠️ Structural change check: ${found.length}${truncated ? '+' : ''} cell(s) show formula errors: ${found.slice(0, 20).join('; ')}. Inspect with trace_precedents and repair references (or undo) before claiming completion.`,
  )
  if (incomplete.length) lines.push(
    `⚠️ Structural change verification INCOMPLETE: ${incomplete.slice(0, 10).join('; ')}. The edits applied, but formula correctness has not been established. Retry find_cells with errors_only after loading/indexing; do not report the workbook error-free.`,
  )
  if (!found.length && !incomplete.length) lines.push('Structural change check: no formula error values found in the completed scans of the affected sheet(s). This does not verify business calculations or all workbook requirements.')
  return `\n${lines.join('\n')}`
}
