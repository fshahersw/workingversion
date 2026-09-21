import type { AgentSkill } from '@genoffice/agent-core'
import { SHEETS_TOOL_CONTRAST, withToolContrast } from '@/lib/agents/tool-contrast'
import basePrompt from './prompts/base.md?raw'
import { verifySheetsResponse } from './response-verify'
import {
  WORKBOOK_TOOLS,
  buildWorkbookContext,
  executeWorkbookTool,
  type SheetsSkillDeps,
} from './tools'

// Contrastive "use for / not for / examples" on every tool (src/lib/agents/tool-contrast.ts).
const TOOLS = withToolContrast(WORKBOOK_TOOLS, SHEETS_TOOL_CONTRAST)

/**
 * The workbook DSL as an AgentSkill: mirrors createDocsSkill's shape
 * (systemPrompt + tools + buildContext + executeTool) so it plugs into the
 * same packages/agent-core AgentLoop docx uses.
 *
 * Prompt layout: the always-loaded base prompt (prompts/base.md) stays small
 * — workflow, op catalog, cross-cutting discipline — while per-domain field
 * definitions and conventions live in prompts/guides/*.md, loaded on demand
 * via load_guide.
 */
export function createWorkbookSkill(deps: SheetsSkillDeps): AgentSkill {
  return {
    id: 'sheets',
    systemPrompt: basePrompt,
    tools: TOOLS,
    buildContext: () => buildWorkbookContext(deps),
    executeTool: (call) => executeWorkbookTool(call, deps),
    verifyResponse: verifySheetsResponse,
  }
}
