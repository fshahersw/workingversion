import type { AgentSkill, AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import { boundCanvas } from '@/office/shared/capture'
import type { TemplateHooks, TemplatePayload } from '@/office/shared/platform-skill'
import { formatAddress, parseRange, type RangeBounds } from '../../domain/cell-address'
import { t } from '../i18n/locale'
import type { SheetsSkillDeps } from './tools'

/**
 * Visual verification for Sheets: view_range scrolls a range into view (the
 * same path as select_range) and captures the grid canvas as a PNG the model
 * can look at. Univer paints the sheet on canvas, so the capture is a plain
 * canvas read; no DOM rasterization needed.
 */
export function createViewSkill(deps: Pick<SheetsSkillDeps, 'selectRange' | 'getActiveSheetInfo'>): AgentSkill {
  const fail = (output: string): ToolExecution => ({ output, isError: true, mutated: false, summary: t('aiToolSelectRange') })
  return {
    id: 'sheets-view',
    systemPrompt:
      '## Visual check\n- view_range shows you the grid as the user sees it (a picture of the sheet around a range). Use it after formatting, width or layout changes to confirm the result, or when the user asks how something looks. Fix what you see, then finish.',
    tools: [
      {
        name: 'view_range',
        readOnly: true,
        description:
          'Scroll a range into view and capture a picture of the grid (PNG) as the user sees it: fonts, fills, borders, column widths, number formats, wrapped text. Use after formatting changes to verify, or when asked how the sheet looks. The image is attached to the result.',
        inputSchema: {
          type: 'object',
          properties: {
            range: { type: 'string', description: 'A1 range to bring into view, e.g. A1:H30' },
            sheetId: { type: 'string', description: 'sheet id (default: active sheet)' },
          },
          required: ['range'],
        },
      },
    ],
    executeTool: async (call: AgentToolCall): Promise<ToolExecution> => {
      if (call.name !== 'view_range') return fail(`Unknown tool: ${call.name}`)
      const raw = call.input.range
      if (typeof raw !== 'string' || !raw.trim()) return fail('range must be a non-empty string')
      let bounds: RangeBounds
      try {
        bounds = parseRange(raw.trim().toUpperCase().replace(/\$/g, ''))
      } catch {
        return fail(`Cannot parse range: ${raw}`)
      }
      const sheetId = typeof call.input.sheetId === 'string' && call.input.sheetId.trim() ? call.input.sheetId.trim() : undefined
      const selected = await deps.selectRange(sheetId, bounds)
      if (!selected.ok) return fail(selected.error ?? 'Selection failed')
      // Let Univer paint the scrolled viewport before reading the canvas.
      await new Promise((resolve) => setTimeout(resolve, 120))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const host = document.getElementById('univer-container')
      const canvases = host ? Array.from(host.querySelectorAll('canvas')) : []
      const main = canvases
        .filter((c) => c.width > 50 && c.height > 50)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0]
      if (!main) return fail('The grid canvas is not available for capture.')
      try {
        const shot = boundCanvas(main)
        const label = `${selected.sheetName ?? ''}!${formatAddress(bounds.startRow, bounds.startColumn)}:${formatAddress(bounds.endRow, bounds.endColumn)}`
        return {
          output: `Captured the grid viewport around ${label} (${shot.width}x${shot.height}px). Inspect the attached image; the selection highlight marks the range.`,
          mutated: false,
          summary: t('aiToolSelectRangeOf', { range: label }),
          images: [{ base64: shot.base64, mime: 'image/png' }],
          display: { kind: 'images', items: [{ url: `data:image/png;base64,${shot.base64}`, title: `View: ${label}` }] },
        }
      } catch (e) {
        return fail(`view_range failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

/**
 * Template hooks for the platform skill: a template's operations target the
 * active sheet ("{{sheetId}}" placeholders) or a freshly added sheet, and run
 * through the same propose_operations path as any other AI edit.
 */
export function sheetsTemplateHooks(
  runPropose: (operations: unknown[], summary: string) => Promise<ToolExecution>,
  deps: Pick<SheetsSkillDeps, 'getActiveSheetInfo'>,
  captureSheet: () => Promise<TemplatePayload>,
): TemplateHooks {
  return {
    apply: async (payload, template, input) => {
      if (payload.format !== 'ops') return { output: 'this template is not a Sheets template', isError: true, mutated: false, summary: t('aiToolPropose') }
      const newSheetName = typeof input['newSheetName'] === 'string' ? input['newSheetName'].trim().slice(0, 31) : ''
      let sheetId = deps.getActiveSheetInfo().sheetId
      if (newSheetName) {
        const created = await runPropose([{ op: 'add_sheet', name: newSheetName }], `Add sheet "${newSheetName}" for template ${template.name}`)
        if (created.isError) return created
        // The new sheet becomes active; re-read the active sheet id.
        const info = deps.getActiveSheetInfo()
        if (info.sheetName === newSheetName) sheetId = info.sheetId
      }
      const json = JSON.stringify(payload.operations).split('{{sheetId}}').join(sheetId)
      const operations = JSON.parse(json) as unknown[]
      const result = await runPropose(operations, `Apply template "${template.name}"`)
      if (result.isError) return result
      return {
        ...result,
        output: `${result.output}\nTemplate "${template.name}" applied on sheet ${sheetId}. Placeholders are written as [Bracketed Labels]; fill them from the user's facts with propose_operations (set_cell / set_range).`,
      }
    },
    capture: captureSheet,
  }
}
