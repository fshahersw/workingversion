// Local test capability manifest applied immediately before provider inference.
// Production tool policy and the renderer's native editing tools are unchanged.
import { localSyntheticEnabled, type LocalEnvironment } from '../local-development'
import type { AgentToolDef } from '../writer/inference.server'

const AWS_ONLY = new Set([
  'run_python', 'load_attachment_for_python', 'generate_image', 'edit_image', 'search_firm_knowledge',
])
const IMAGE_RETURNING = new Set([
  'view_range', 'view_page', 'view_slide', 'pdf_capture_page', 'render_diagram', 'analyze_media',
])

function properties(tool: AgentToolDef): Record<string, unknown> {
  const value = tool.inputSchema.properties
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function localOfficeCapabilities<T extends { system: string; tools: AgentToolDef[] }>(
  request: T, env: LocalEnvironment = process.env,
): T {
  if (!localSyntheticEnabled(env)) return request
  const unavailable = new Set(AWS_ONLY)
  const noVision = env.OFFICE_LOCAL_PROVIDER?.trim() === 'fireworks' && env.OFFICE_LOCAL_FIREWORKS_VISION !== '1'
  if (noVision) for (const name of IMAGE_RETURNING) unavailable.add(name)
  if (!env.COURTLISTENER_API_TOKEN?.trim()) unavailable.add('verify_citations')
  if (!env.TAVILY_API_KEY?.trim()) unavailable.add('image_search')
  if (!(env.OFFICE_LOCAL_PROVIDER === 'anthropic' || env.OFFICE_LOCAL_SEARCH_PROVIDER === 'anthropic') ||
      !env.ANTHROPIC_API_KEY?.trim() || !env.OFFICE_LOCAL_ANTHROPIC_MODEL?.trim()) unavailable.add('web_search')
  const tools = request.tools.filter(tool => !unavailable.has(tool.name)).map(tool => {
    if (tool.name === 'render_diagram') {
      const { engine: _engine, ...fields } = properties(tool)
      return { ...tool,
        description: 'Render Mermaid source in the browser and return an image handle. Available kinds: Mermaid flowchart, sequence, timeline, gantt, pie or quadrant. Use native editable charts for workbook figures. Inspect the rendering before inserting. Graphviz is unavailable in this local workspace.',
        inputSchema: { ...tool.inputSchema, properties: { ...fields, kind: { type: 'string', enum: ['mermaid'] }, source: { type: 'string', description: 'Mermaid source' } } },
      }
    }
    if (tool.name === 'create_document') {
      const fields = properties(tool)
      // Sheets owns a separate exporter under the same tool name. Its native
      // CSV/download and XLSX/Library paths work locally; authored documents
      // use AWS docgen. Never replace that executor's `type` with platform `kind`.
      if ('type' in fields && 'sheetId' in fields && !('kind' in fields)) {
        const { content: _content, ...nativeFields } = fields
        return { ...tool,
          description: 'Export one worksheet as a separate values-only XLSX in the local Library or a CSV browser download. Pass type xlsx (default) or csv, optional sheetId and title. Omit content: data comes from the selected worksheet. Formulas, formatting, charts and other sheets are not carried over. Use the editor Save and Download controls to preserve the complete native workbook. DOCX, PDF and Markdown creation are unavailable through this tool in the local workspace.',
          inputSchema: { ...tool.inputSchema, additionalProperties: false, properties: { ...nativeFields, type: { type: 'string', enum: ['xlsx', 'csv'] } } },
        }
      }
      // Writer also owns its executor: it expects type + restricted HTML.
      // Require type explicitly because that executor otherwise defaults DOCX.
      if ('type' in fields && !('kind' in fields)) {
        return { ...tool,
          description: 'Create a separate editable PPTX in the local Library. Set type to pptx explicitly. Supply restricted HTML in content: headings become slides and list items become bullets. The current document is unchanged. DOCX, PDF and Markdown creation are unavailable through this tool in the local workspace.',
          inputSchema: { ...tool.inputSchema, additionalProperties: false,
            required: [...new Set([...(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required as string[] : []), 'type'])],
            properties: { ...fields, type: { type: 'string', enum: ['pptx'] }, content: { type: 'string', description: 'Restricted HTML with headings and bullet lists, not Markdown' } },
          },
        }
      }
      const { style: _style, ...platformFields } = fields
      return { ...tool,
        description: 'Create a separate editable PPTX in the local Library from Markdown headings and bullets. Only kind pptx is available through this tool in the local workspace. Use native editor operations for the open workbook or document; this tool does not edit it.',
        inputSchema: { ...tool.inputSchema, properties: { ...platformFields, kind: { type: 'string', enum: ['pptx'] }, content: { type: 'string', description: 'Markdown slide headings and bullet lists' } } },
      }
    }
    return tool
  })
  // Remove the shared platform prompt's explicit unavailable recommendations.
  // The final runtime paragraph also overrides older generic guides in history.
  const system = request.system.split('\n').filter(line => {
    const names = line.match(/^\s*-\s+([a-z_]+(?:\s*\/\s*[a-z_]+)*):/)?.[1]?.split(/\s*\/\s*/)
    return !names?.some(name => unavailable.has(name) || name === 'create_document')
  }).join('\n')
  const visionNote = noVision
    ? '\nVisual inspection is unavailable for the current local model configuration. Screenshot/capture tools and image-returning helpers are omitted because their results cannot be read by this model. Use native text/data/formula/format/geometry reads and deterministic audits where supplied. Do not claim to have visually inspected the result or verified its appearance. If visual review is required, report that remaining limitation; do not guess PDF whitespace or image content.' : ''
  return { ...request, tools, system: `${system}\n\nCurrent local workspace capabilities (authoritative for this request):\nOnly the supplied tool definitions are available. Generic guides and earlier tool references do not enable missing tools. AWS Python/Graphviz execution, Python attachment staging, image generation/editing and firm knowledge retrieval are unavailable; do not plan or claim those actions. Use the native editor's available operations, formulas, aggregation/readback and editable charts to complete supported work. For mock data, label assumptions explicitly and calculate derived values with workbook formulas; do not substitute guessed arithmetic for verified results. Separate-file creation is limited to the supplied create_document schema; formats and content syntax differ by editor. Mermaid rendering, public search, image search and citation lookup are available only when their definitions are supplied. If a required capability is absent, state the specific limitation and continue the supported work.${visionNote}` }
}
