import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { ChartDisplay, CommentInfo, NewChart, TableCell } from '@genoffice/docx-engine'
import { TABLE_HEADER_FILL } from '@genoffice/docx-engine'
import { tableModelToPmNode } from '../editor/convert'
import type { AgentToolCall, AgentToolDef, CreateDocumentType } from '../../shared/ipc'
import type { AgentImage, ToolDisplay } from '@genoffice/agent-core'
import { createPlatformSkill } from '@/office/shared/platform-skill'
import { captureElement } from '@/office/shared/capture'
import { getPlatformImage, isPlatformImage } from '@/office/shared/image-store'
import { t } from '../i18n/locale'
import { executeCommands, type Command, type CommandEnvelope } from './commands'
import {
  blockRangePositions,
  buildCommentsContext,
  buildDocumentContext,
  buildRevisionsContext,
  insertBlocksAfter,
  isBlankDocument,
  isTrackedDeleted,
  parseHtmlFragment,
  replaceBlockRange,
  serializeRangeToHtml,
  type AiHfState,
  type AiTrack,
  type NumIds,
  type SelectionScope,
} from './protocol'

/**
 * Local agent tools: a document-context reader plus a script-style execution
 * channel. The "execution backend" is the in-process ProseMirror doc, split
 * into three safe primitives plus the deterministic command engine.
 */

const READ_MAX_CHARS = 120_000

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'view_page',
    readOnly: true,
    description:
      'Capture a rendering of the document as it looks on screen (PNG) so you can check layout, fonts, tables, alignment and spacing visually. Optionally limit the capture to a block range; without a range the capture starts at the top of the document. Use after formatting edits to verify the result, or when the user asks about how something looks. The image is attached to the result.',
    inputSchema: {
      type: 'object',
      properties: {
        startBlockIndex: { type: 'integer', description: 'first block to include (0-based)' },
        endBlockIndex: { type: 'integer', description: 'last block to include (inclusive)' },
        scale: { type: 'number', description: 'render scale 0.5-2, default 1.25' },
      },
      required: [],
    },
  },
  {
    name: 'get_document_context',
    readOnly: true,
    description:
      'Get the latest state of the current document: block list (index|type|content preview), full-text stats (word/character counts) and the current selection. Block indexes change after modifications; call this when you need up-to-date indexes.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_blocks',
    readOnly: true,
    description:
      'Read the full content of a block range (restricted HTML). Previews in the block list are truncated; you must read the full original text with this tool before rewriting. ' +
      'Long ranges are paged: a truncated result says which offset to continue from; concatenate the slices in order to get the full HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        startBlockIndex: { type: 'integer', description: 'start block index (0-based, inclusive)' },
        endBlockIndex: { type: 'integer', description: 'end block index (inclusive)' },
        offset: {
          type: 'integer',
          description:
            'character offset to continue a truncated read (default 0); use the offset given in the previous truncation notice',
        },
      },
      required: ['startBlockIndex', 'endBlockIndex'],
    },
  },
  {
    name: 'insert_content',
    description:
      'Insert new content at a given position (restricted HTML, may contain multiple blocks). For writing/continuing/generating new content; to rewrite existing content use replace_blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'restricted HTML fragment to insert' },
        afterBlockIndex: {
          type: 'integer',
          description:
            'insert after this block index; -1 = start of document; omitted = after the block containing the cursor',
        },
      },
      required: ['html'],
    },
  },
  {
    name: 'replace_blocks',
    description:
      "Replace a block range with new content (restricted HTML). For rewriting/translating/condensing/expanding existing content; the new block count may differ from the old. New blocks inherit the replaced blocks' paragraph and text formatting (font, size, color, indent, spacing, alignment) automatically, and a rewritten <table> keeps the old table's column widths, borders, shading and cell formatting (unchanged cells keep their content); never try to restore formatting afterwards.",
    inputSchema: {
      type: 'object',
      properties: {
        startBlockIndex: { type: 'integer', description: 'start block index (0-based, inclusive)' },
        endBlockIndex: { type: 'integer', description: 'end block index (inclusive)' },
        html: { type: 'string', description: 'replacement restricted HTML fragment' },
      },
      required: ['startBlockIndex', 'endBlockIndex', 'html'],
    },
  },
  {
    name: 'apply_commands',
    description:
      'Execute formatting/structure/batch commands (batchUpdate style, see the command guide in the system prompt): text style (whole-block or matched-text-only), paragraph format, heading level, find & replace, delete/move blocks, list conversion, image properties, TOC insertion.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description: 'array of commands executed in order; each command is a single-key object',
          items: { type: 'object' },
        },
      },
      required: ['commands'],
    },
  },
  {
    name: 'read_revisions',
    readOnly: true,
    description:
      'List every pending tracked revision (insertions, deletions, formatting/move/table changes) with kind, author, date, block index and the affected text. Read-only: revisions are accepted/rejected by the user in the Review tab.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_comments',
    readOnly: true,
    description:
      'List all comment threads (including resolved ones) with ids, authors, anchored block indexes and anchor text. Unresolved threads already ride along in the message context; use this for the full picture.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'reply_comment',
    description:
      'Add a reply to a comment thread: after completing a requested change (summarize what changed), or to answer/ask back when the comment is a question or is ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'id of the comment thread to reply to' },
        text: { type: 'string', description: 'reply text' },
      },
      required: ['parentId', 'text'],
    },
  },
  {
    name: 'resolve_comment',
    description:
      'Mark a comment thread as resolved. Only after the requested change was applied (reply first), or when the user explicitly asked to resolve.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id of the comment thread to resolve' },
      },
      required: ['id'],
    },
  },
  {
    name: 'web_search',
    readOnly: true,
    description:
      'Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search keywords' },
        maxResults: { type: 'integer', description: 'maximum number of results, default 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'image_search',
    readOnly: true,
    description:
      'Search for images. Returns a list of image imageUrl entries; after picking one, insert it into the document with insert_image.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'image search keywords (English works better)' },
        maxResults: { type: 'integer', description: 'maximum number of results, default 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'insert_image',
    description:
      'Insert an image into the document (at the cursor / end of document): a platform-image:<id> handle returned by render_diagram, generate_image or run_python, or a direct image link.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'platform-image:<id> handle or a direct image link' },
        maxWidthPx: { type: 'integer', description: 'maximum width (px), default 480' },
      },
      required: ['url'],
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an illustration with Amazon Nova Canvas from a text prompt and insert it into the document (at the cursor / end of document): cover art, icons, abstract backgrounds, illustrations. Not for real people or trademarks; for diagrams use render_diagram.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'detailed English description of the image to generate (subject, style, composition, palette)',
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
          description: 'default 1:1',
        },
        negativePrompt: { type: 'string', description: 'what to avoid (text, watermarks, clutter)' },
        maxWidthPx: { type: 'integer', description: 'maximum width (px), default 480' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'insert_chart',
    description:
      'Insert a chart (saved as a native Word chart). Data must be real: from the document content or web_search results — do not make up numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'chart type' },
        title: { type: 'string', description: 'chart title' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'category (x axis / sector) labels',
        },
        series: {
          type: 'array',
          description:
            'data series; values has the same length as categories, use null for missing data. Pie charts use only the first series',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: ['number', 'null'] } },
            },
            required: ['values'],
          },
        },
        afterBlockIndex: {
          type: 'integer',
          description:
            'insert after this block index; -1 = start of document; omitted = after the block containing the cursor',
        },
      },
      required: ['kind', 'categories', 'series'],
    },
  },
  {
    name: 'edit_chart',
    description:
      'Edit the data of an existing chart in the document (title/category labels/series names/values). Chart blocks in the block list can be edited; ' +
      'the category count and the number of values per series must match the original chart (data points cannot be added or removed).',
    inputSchema: {
      type: 'object',
      properties: {
        blockIndex: { type: 'integer', description: 'block index of the chart' },
        title: { type: 'string', description: 'new title (omit to keep)' },
        categories: {
          type: 'array',
          items: { type: ['string', 'null'] },
          description:
            'new category labels, same length as the original; pass null for positions to keep',
        },
        series: {
          type: 'array',
          description: 'series to change',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer', description: 'series index (0-based)' },
              name: { type: 'string', description: 'new series name (omit to keep)' },
              values: {
                type: 'array',
                items: { type: ['number', 'null'] },
                description:
                  'new values, same length as the original series; pass null for positions to keep',
              },
            },
            required: ['index'],
          },
        },
      },
      required: ['blockIndex'],
    },
  },
  {
    name: 'insert_table',
    description:
      'Insert a native table with an optional header row, body rows, optional relative column widths and a firm style preset. Cells hold plain text (use \\n for line breaks). Prefer this over an HTML <table> whenever you want column widths or a banded / header style.',
    inputSchema: {
      type: 'object',
      properties: {
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'header (first) row cell texts; omit or pass [] for a table with no header row',
        },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'body rows, each an array of plain-text cell values',
        },
        colWidths: {
          type: 'array',
          items: { type: 'number' },
          description:
            'optional relative column widths (any units; normalized to percentages); length must equal the column count',
        },
        stylePreset: {
          type: 'string',
          enum: ['none', 'lightGrid', 'zebraBlue', 'zebraGray', 'headerDarkBlue', 'headerOrange', 'noBorder', 'fullBorder'],
          description: 'optional visual style (default: plain single-border grid)',
        },
        afterBlockIndex: {
          type: 'integer',
          description:
            'insert after this block index; -1 = start of document; omitted = after the block containing the cursor',
        },
      },
      required: ['rows'],
    },
  },
  {
    name: 'set_header_footer',
    description:
      'Set the page header or footer text (the current contents are listed in the message context). Plain text; \\n separates lines; the tokens {PAGE} and {NUMPAGES} become live page-number fields; an empty string clears the text. ' +
      'Per-line alignment/styling of the existing header/footer is preserved; images in it are untouched. view "first"/"even" writes the different-first-page / even-page variant (enabling that setting if needed).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['header', 'footer'] },
        text: {
          type: 'string',
          description: 'new text; \\n between lines; may contain {PAGE} / {NUMPAGES}; "" clears',
        },
        view: {
          type: 'string',
          enum: ['default', 'first', 'even'],
          description: 'which variant to write (default when omitted)',
        },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'create_document',
    description:
      'Create a NEW separate document in the Library and return a link to open it; the current document is not modified. Use when the user asks to put content into a new/separate document (a memo from these notes, a deck summarizing this brief). ' +
      "type 'docx' (default, opens in the Writer), 'pptx' (opens in Slides; each heading becomes a slide, list items become bullets) or 'pdf' (downloaded) take the same restricted HTML as insert_content in content; type 'md' takes Markdown source and produces a Word document. Images and charts are not carried into the new file.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['docx', 'pptx', 'pdf', 'md'],
          description: "target file type (default 'docx')",
        },
        title: { type: 'string', description: 'document title, used as the file name' },
        content: {
          type: 'string',
          description: 'full document content: restricted HTML for docx/pptx/pdf, Markdown for md',
        },
      },
      required: ['title', 'content'],
    },
  },
]

// Platform build: shared server-side and browser-side tools (Python sandbox,
// Graphviz/Mermaid diagrams, citation verification, page reading, firm guides,
// clarification card). generate_image and create_document keep the Writer's own
// definitions above and are routed to the platform in executeAsyncTool.
/** Editor the current tool call targets; set by executeTool before platform tools run. */
let activeEditor: Editor | null = null
let activeNumIds: NumIds | null = null
let activeTrack: AiTrack | undefined

const platformSkill = createPlatformSkill({
  app: 'writer',
  exclude: ['generate_image', 'create_document'],
  templates: {
    apply: async (payload, template, input) => {
      const editor = activeEditor
      if (!editor) return fail(t('aiSumInsertContent'), 'the editor is not available')
      if (payload.format !== 'html') return fail(t('aiSumInsertContent'), 'this template is not a Writer template')
      const echo = toolEchoError(payload.html)
      if (echo) return fail(t('aiSumInsertContent'), echo)
      let nodes: ReturnType<typeof parseHtmlFragment>
      try {
        nodes = parseHtmlFragment(payload.html, activeNumIds ?? { bullet: null, ordered: null })
      } catch (e) {
        return fail(t('aiSumInsertContent'), e instanceof Error ? e.message : String(e))
      }
      if (!nodes.length) return fail(t('aiSumInsertContent'), 'the template produced no content blocks')
      const count = editor.state.doc.childCount
      if (input['replace'] === true || isBlankDocument(editor)) {
        replaceBlockRange(editor, 0, count - 1, nodes, activeTrack)
      } else {
        insertBlocksAfter(editor, count - 1, nodes, activeTrack)
      }
      markDocSeen(editor)
      return {
        output: `Applied template "${template.name}" (${nodes.length} blocks). Placeholders are written as [Bracketed Labels]; call get_document_context, then fill them from the user's facts with replace_blocks or apply_commands (find & replace).`,
        mutated: true,
        summary: t('aiSumInsertedBlocks', { count: nodes.length }),
      }
    },
    capture: async () => {
      const editor = activeEditor
      if (!editor) throw new Error('the editor is not available')
      const html = serializeRangeToHtml(editor, 0, editor.state.doc.childCount - 1)
      if (!html.trim()) throw new Error('the document is empty')
      return { format: 'html', html }
    },
  },
})
AGENT_TOOLS.push(...platformSkill.tools)
export const PLATFORM_SYSTEM_PROMPT = platformSkill.systemPrompt
const PLATFORM_TOOL_NAMES = new Set(platformSkill.tools.map((tool) => tool.name))

/**
 * App-owned header/footer state, handed to the tool executor. Writes run the
 * same commit path as on-canvas editing (variant routing, per-section edits,
 * dirty flags), so the docx save path needs no changes.
 */
export interface AiHeaderFooterAccess {
  read(): AiHfState
  /** returns an error message, or null on success */
  set(kind: 'header' | 'footer', view: 'default' | 'first' | 'even', text: string): string | null
}

/**
 * The App-owned comments store, handed to the tool executor. Mutations run
 * the same review-actions code paths as the comments pane, so AI replies and
 * resolves behave exactly like manual ones (anchors, dirty flags, docx save).
 */
export interface AiCommentsAccess {
  list(): CommentInfo[]
  /** false when the parent thread or its anchor no longer exists */
  reply(parentId: string, text: string): boolean
  /** false when the thread does not exist */
  resolve(id: string): boolean
}

/**
 * Selection frozen at context build, valid only while `doc` is still the live
 * document. A user click elsewhere keeps the doc identical (selection-only
 * transaction) so the freeze holds; once any edit lands, the live selection —
 * which ProseMirror has remapped through those edits — is the correct target
 * again and the frozen block indexes would drift, so the freeze is dropped.
 */
export interface FrozenSelection {
  scope: SelectionScope
  doc: ProseMirrorNode
}

export interface ToolExecution {
  /** result text fed back to the model */
  output: string
  isError?: boolean
  /** true when the tool changed the document */
  mutated: boolean
  /** short human-readable label for the chat activity chip */
  summary: string
  /** UI-only side channel (image thumbnails, links); never sent to the model */
  display?: ToolDisplay
  /** images the model should look at (captures, generated pictures) */
  images?: AgentImage[]
}

const fail = (summary: string, output: string): ToolExecution => ({
  output,
  isError: true,
  mutated: false,
  summary,
})

/**
 * A model that saw gateway-flattened tool results can regurgitate them as the
 * html argument (raw {"index":…} block dumps, literal </tool_response> tags);
 * reject those so protocol artifacts never land in the document as text.
 */
function toolEchoError(html: string): string | null {
  if (/<\/?tool_response>/i.test(html)) {
    return 'html contains a literal <tool_response> tag — that is tool-protocol output, not document content; retry with the actual restricted-HTML fragment'
  }
  // the context/read dump shape is screened anywhere in the payload (fenced or
  // prose-wrapped dumps included) — it is never legitimate document content
  if (/"index"\s*:\s*\d+\s*,\s*"type"\s*:\s*"/.test(html)) {
    return 'html contains a raw JSON block dump, not an HTML fragment; retry with restricted HTML (e.g. <p>…</p>)'
  }
  // unwrap only a fully fenced payload; an embedded fence inside otherwise
  // valid HTML must not shadow the real content
  let candidate = html.trim()
  const fence = /^```[a-z]*\s*([\s\S]*?)```\s*$/i.exec(candidate)
  if (fence) candidate = fence[1].trim()
  if (!/^[[{]/.test(candidate)) return null
  try {
    JSON.parse(candidate)
    return 'html is raw JSON, not an HTML fragment; retry with restricted HTML (e.g. <p>…</p>)'
  } catch {
    return null // brace-led plain text is legitimate content
  }
}

/** Doc as last seen by the AI pipeline (context build / read / own write); a differing doc means the user edited in between. */
const docBaseline = new WeakMap<Editor, ProseMirrorNode>()

export function markDocSeen(editor: Editor): void {
  docBaseline.set(editor, editor.state.doc)
}

/** A streamed load tail is not a user edit: appending at the end keeps every block index the model saw valid. */
export function carryDocSeen(editor: Editor, before: ProseMirrorNode): void {
  if (docBaseline.get(editor) === before) docBaseline.set(editor, editor.state.doc)
}

function editedExternally(editor: Editor): boolean {
  const seen = docBaseline.get(editor)
  return seen !== undefined && seen !== editor.state.doc
}

/** tools addressing the document by block index: refused after an external edit until the model re-reads */
const INDEX_WRITE_SUMMARIES: Record<string, () => string> = {
  insert_content: () => t('aiSumInsertContent'),
  replace_blocks: () => t('aiSumReplaceContent'),
  apply_commands: () => t('aiSumApplyCommands'),
  insert_chart: () => t('aiSumInsertChart'),
  edit_chart: () => t('aiSumEditChart'),
  insert_table: () => t('aiSumInsertContent'),
}

const STALE_DOC_ERROR =
  'The document was edited by the user since it was last read; block indexes may be stale. ' +
  'Call get_document_context (or read_blocks) to get the current state, then retry.'

function rangeError(editor: Editor): string {
  return `block index invalid or out of range (the document has ${editor.state.doc.childCount} blocks); call get_document_context for fresh indexes`
}

/** Self-contained table style presets (fills/text/border baked into the model at
 *  build time, so no styles.xml dependency and no post-insert selection needed).
 *  Hexes are without '#', matching TableCell.fill/color; shared naming with Slides. */
type TablePresetSpec = {
  headerFill: string | null
  headerText: string | null
  band1Fill: string | null
  band2Fill: string | null
  borderColor: string
  border: boolean
}
const TABLE_PRESETS: Record<string, TablePresetSpec> = {
  none: { headerFill: TABLE_HEADER_FILL, headerText: null, band1Fill: null, band2Fill: null, borderColor: 'auto', border: true },
  lightGrid: { headerFill: 'F2F2F2', headerText: null, band1Fill: null, band2Fill: null, borderColor: 'BFBFBF', border: true },
  zebraBlue: { headerFill: '4472C4', headerText: 'FFFFFF', band1Fill: 'D6E4F0', band2Fill: 'FFFFFF', borderColor: 'C9D8EA', border: true },
  zebraGray: { headerFill: '595959', headerText: 'FFFFFF', band1Fill: 'EDEDED', band2Fill: 'FFFFFF', borderColor: 'BFBFBF', border: true },
  headerDarkBlue: { headerFill: '1F3864', headerText: 'FFFFFF', band1Fill: 'E9EDF5', band2Fill: 'FFFFFF', borderColor: 'D9D9D9', border: true },
  headerOrange: { headerFill: 'ED7D31', headerText: 'FFFFFF', band1Fill: 'FBE5D6', band2Fill: 'FFFFFF', borderColor: 'D9D9D9', border: true },
  noBorder: { headerFill: 'F2F2F2', headerText: null, band1Fill: 'F2F2F2', band2Fill: null, borderColor: 'auto', border: false },
  fullBorder: { headerFill: TABLE_HEADER_FILL, headerText: null, band1Fill: null, band2Fill: null, borderColor: '000000', border: true },
}

/** Build one table row's cells, baking the preset's fill/text/bold per row index (0 = header). */
function tableRowCells(cells: string[], cols: number, rowIndex: number, isHeader: boolean, p: TablePresetSpec): TableCell[] {
  const fill = isHeader ? p.headerFill : rowIndex % 2 === 0 ? p.band2Fill : p.band1Fill
  const out: TableCell[] = []
  for (let c = 0; c < cols; c++) {
    const cell: TableCell = { paras: [cells[c] ?? ''] }
    if (isHeader) cell.bold = true
    if (fill) cell.fill = fill
    if (isHeader && p.headerText) cell.color = p.headerText
    out.push(cell)
  }
  return out
}

function validRange(
  editor: Editor,
  start: unknown,
  end: unknown,
): { start: number; end: number } | null {
  const count = editor.state.doc.childCount
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const s = Number(start)
  const e = Number(end)
  // an out-of-range end must surface as an error, not silently clamp onto the wrong blocks
  if (s < 0 || e < s || e >= count) return null
  return { start: s, end: e }
}

/** Read the natural size of a dataURL image. */
function imageSizeOf(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 })
    img.onerror = () => reject(new Error('image load failed'))
    img.src = dataUrl
  })
}

/** Async tools: web search / image search / insert web image. */
async function executeAsyncTool(
  editor: Editor,
  call: AgentToolCall,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  switch (call.name) {
    case 'web_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiSumWebSearch'), 'query must not be empty')
      const r = await window.desktop.webSearch(query, Number(call.input.maxResults) || 6)
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === 'error') {
        return fail(
          t('aiSumWebSearch'),
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      const lines: string[] = []
      if (r.answer) lines.push(`Direct answer: ${r.answer}\n`)
      r.results.forEach((it, i) =>
        lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`),
      )
      return {
        output: lines.join('\n') || '(no results)',
        mutated: false,
        summary: t('aiSumWebSearchDone', { query, count: r.results.length }),
      }
    }
    case 'image_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiSumImageSearch'), 'query must not be empty')
      const r = await window.desktop.imageSearch(query, Number(call.input.maxResults) || 8)
      // a backend failure must not read as an empty gallery — the model would fabricate image choices
      if (r.method === 'error') {
        return fail(
          t('aiSumImageSearch'),
          `image search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      const lines = r.images.map(
        (im, i) =>
          `${i + 1}. ${im.title || '(untitled)'} [${im.width ?? '?'}x${im.height ?? '?'}]\n   ${im.imageUrl}`,
      )
      return {
        output: lines.join('\n') || '(no images)',
        mutated: false,
        summary: t('aiSumImageSearchDone', { query, count: r.images.length }),
      }
    }
    case 'insert_image': {
      const url = String(call.input.url ?? '').trim()
      // Accepts a direct http(s) URL or a platform-image:<id> handle from
      // generate_image / render_diagram / run_python / edit_image.
      if (!/^https?:\/\//.test(url) && !isPlatformImage(url))
        return fail(t('aiSumInsertImage'), 'url must be an http(s) URL or a platform-image:<id> handle')
      return insertImageFromUrl(editor, url, Number(call.input.maxWidthPx) || 480, signal, {
        failLabel: t('aiSumInsertImage'),
        doneLabel: t('aiSumInsertWebImage'),
        blockLabel: 'Image (web)',
      })
    }
    case 'generate_image': {
      // Platform build: Amazon Nova Canvas through the platform, then the same
      // protected-image insertion as a downloaded picture.
      const prompt = String(call.input.prompt ?? '').trim()
      if (!prompt) return fail(t('aiSumGenerateImage'), 'prompt must not be empty')
      const aspectRatio = String(call.input.aspectRatio ?? '').trim()
      const negativePrompt = String(call.input.negativePrompt ?? '').trim()
      let generated: { mime: 'image/png' | 'image/jpeg'; base64: string }
      try {
        const { officeGenerateImageFn } = await import('@/lib/office/tools.functions')
        generated = await officeGenerateImageFn({
          data: {
            prompt,
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(negativePrompt ? { negativePrompt } : {}),
          },
        })
      } catch (e) {
        return fail(t('aiSumGenerateImage'), e instanceof Error ? e.message : 'image generation failed')
      }
      if (signal?.aborted)
        return fail(t('aiSumGenerateImage'), 'stopped by the user; the image was not inserted')
      return insertImageBase64(editor, generated.base64, Number(call.input.maxWidthPx) || 480, signal, {
        failLabel: t('aiSumGenerateImage'),
        doneLabel: t('aiSumInsertedGenImage'),
        blockLabel: 'Image (AI)',
      })
    }
    case 'create_document': {
      // Platform build: the new document lands in the Library (docx opens in
      // the Writer, pptx in Slides, pdf downloads); the current document is untouched.
      const typeRaw = call.input.type === undefined ? 'docx' : String(call.input.type)
      if (typeRaw !== 'docx' && typeRaw !== 'pdf' && typeRaw !== 'md' && typeRaw !== 'pptx')
        return fail(t('aiSumCreateDocument'), 'type must be one of docx/pptx/pdf/md')
      const type = typeRaw as CreateDocumentType | 'pptx'
      const title = String(call.input.title ?? '').trim()
      if (!title) return fail(t('aiSumCreateDocument'), 'title must not be empty')
      const content = String(call.input.content ?? '')
      if (!content.trim()) return fail(t('aiSumCreateDocument'), 'content must not be empty')
      if (type !== 'md') {
        const echo = toolEchoError(content)
        if (echo) return fail(t('aiSumCreateDocument'), echo)
        try {
          if (parseHtmlFragment(content, { bullet: null, ordered: null }).length === 0)
            return fail(t('aiSumCreateDocument'), 'content did not parse into any content blocks')
        } catch (e) {
          return fail(t('aiSumCreateDocument'), e instanceof Error ? e.message : String(e))
        }
      }
      try {
        const { officeCreateDocumentFn } = await import('@/lib/office/tools.functions')
        const r = await officeCreateDocumentFn({
          data: {
            kind: type === 'md' ? 'docx' : type,
            title,
            markdown: content,
            format: type === 'md' ? 'markdown' : 'html',
          },
        })
        if (r.kind === 'pdf') {
          const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
          const a = document.createElement('a')
          a.href = url
          a.download = r.name
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 30_000)
          return {
            output: `Created ${r.name}; the browser downloaded it.`,
            mutated: false,
            summary: t('aiSumCreatedDocument', { name: r.name }),
          }
        }
        const href = `${location.origin}${r.url}`
        return {
          output: `Created "${r.doc.name}" in the Library. Open it at ${href} . Tell the user it is ready and give this link.`,
          mutated: false,
          summary: t('aiSumCreatedDocument', { name: r.doc.name }),
          display: { kind: 'links', items: [{ url: href, title: r.doc.name }] },
        }
      } catch (e) {
        return fail(t('aiSumCreateDocument'), e instanceof Error ? e.message : 'creating the document failed')
      }
    }
    default:
      return fail(t('aiSumUnknownTool'), call.name)
  }
}

/** magic-byte sniff: the fetch handler's content-type mapping defaults unknown
 *  types to jpeg, and a webp/svg mislabeled as jpeg breaks the exported docx */
export function sniffImageMime(base64: string): 'image/png' | 'image/jpeg' | 'image/gif' | null {
  let head: string
  try {
    head = atob(base64.slice(0, 12))
  } catch {
    return null
  }
  if (head.startsWith('\x89PNG')) return 'image/png'
  if (head.startsWith('GIF8')) return 'image/gif'
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return 'image/jpeg'
  return null
}

/** download a direct image URL (or resolve a platform-image handle) and insert it at the cursor as a protected image block */
async function insertImageFromUrl(
  editor: Editor,
  url: string,
  maxW: number,
  signal: AbortSignal | undefined,
  labels: { failLabel: string; doneLabel: string; blockLabel: string },
): Promise<ToolExecution> {
  if (isPlatformImage(url)) {
    const stored = getPlatformImage(url)
    if (!stored)
      return fail(labels.failLabel, 'that image handle is no longer available; produce the image again')
    return insertImageBase64(editor, stored.base64, maxW, signal, labels)
  }
  const fetched = await window.desktop.fetchImage(url)
  // never write after the user hit stop (the download may resolve long after the abort)
  if (signal?.aborted)
    return fail(labels.failLabel, 'stopped by the user; the image was not inserted')
  if (!fetched) return fail(labels.failLabel, 'download failed (the image may not be accessible)')
  return insertImageBase64(editor, fetched.base64, maxW, signal, labels)
}

/** insert raw image bytes (base64) at the cursor as a protected image block */
async function insertImageBase64(
  editor: Editor,
  base64: string,
  maxW: number,
  signal: AbortSignal | undefined,
  labels: { failLabel: string; doneLabel: string; blockLabel: string },
): Promise<ToolExecution> {
  const fetched = { base64 }
  const mime = sniffImageMime(fetched.base64)
  if (!mime) {
    return fail(
      labels.failLabel,
      'unsupported image format (only png/jpg/gif can be embedded) — pick a different image',
    )
  }
  const dataUrl = `data:${mime};base64,${fetched.base64}`
  try {
    const natural = await imageSizeOf(dataUrl)
    if (signal?.aborted)
      return fail(labels.failLabel, 'stopped by the user; the image was not inserted')
    const scale = Math.min(1, maxW / natural.width)
    const w = Math.round(natural.width * scale)
    const h = Math.round(natural.height * scale)
    // The download can take long: user edits made meanwhile must keep the
    // freshness baseline stale, so only our own insertion may mark the doc
    // seen. Checked right before the write — there is no async gap after.
    const userEditedDuringFetch = editedExternally(editor)
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'docProtected',
        attrs: {
          docxIndex: null,
          blockType: 'image',
          label: labels.blockLabel,
          imageDataUrl: dataUrl,
          imageWidthPx: w,
          imageHeightPx: h,
          genImage: { base64: fetched.base64, mime, widthPx: w, heightPx: h },
        },
      })
      .run()
    if (!userEditedDuringFetch) markDocSeen(editor)
    return {
      output: `Inserted the image (${w}×${h}px).`,
      mutated: true,
      summary: labels.doneLabel,
    }
  } catch {
    return fail(labels.failLabel, 'the image could not be decoded')
  }
}

export function executeTool(
  editor: Editor,
  call: AgentToolCall,
  numIds: NumIds,
  track?: AiTrack,
  signal?: AbortSignal,
  frozen?: FrozenSelection | null,
  comments?: AiCommentsAccess,
  hf?: AiHeaderFooterAccess,
): ToolExecution | Promise<ToolExecution> {
  const scope = frozen && frozen.doc === editor.state.doc ? frozen.scope : null
  activeEditor = editor
  activeNumIds = numIds
  activeTrack = track
  const staleSummary = INDEX_WRITE_SUMMARIES[call.name]
  if (staleSummary && editedExternally(editor)) return fail(staleSummary(), STALE_DOC_ERROR)
  if (call.name === 'view_page') return viewPage(editor, call)
  const settle = (exec: ToolExecution): ToolExecution => {
    const readsDoc = call.name === 'get_document_context' || call.name === 'read_blocks'
    if (exec.mutated || (readsDoc && !exec.isError)) markDocSeen(editor)
    return exec
  }
  // Async tools take a separate Promise branch; the other sync tools keep returning
  // synchronously (doesn't break existing tests). No settle here: marking the doc
  // seen after the long download would baptize user edits made meanwhile —
  // insert_image maintains the baseline itself right at its synchronous write.
  if (PLATFORM_TOOL_NAMES.has(call.name)) {
    // Platform tools never touch the document; normalize the shared shape to
    // the Writer's (mutated is required here).
    return Promise.resolve(platformSkill.executeTool(call, signal)).then((exec) => ({
      ...exec,
      mutated: exec.mutated ?? false,
    }))
  }
  if (
    call.name === 'web_search' ||
    call.name === 'image_search' ||
    call.name === 'insert_image' ||
    call.name === 'generate_image' ||
    call.name === 'create_document'
  ) {
    return executeAsyncTool(editor, call, signal)
  }
  return settle(executeSyncTool(editor, call, numIds, track, scope, comments, hf))
}

function executeSyncTool(
  editor: Editor,
  call: AgentToolCall,
  numIds: NumIds,
  track?: AiTrack,
  scope?: SelectionScope | null,
  comments?: AiCommentsAccess,
  hf?: AiHeaderFooterAccess,
): ToolExecution {
  switch (call.name) {
    case 'get_document_context':
      return {
        // the still-valid frozen scope keeps the reported selection consistent
        // with what scope:'selection' and cursor-relative inserts will act on
        output: buildDocumentContext(editor, scope ?? undefined, hf?.read()),
        mutated: false,
        summary: t('aiSumReadDocContext'),
      }

    case 'read_blocks': {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex)
      if (!range) return fail(t('aiSumReadBlocks'), rangeError(editor))
      const html = serializeRangeToHtml(editor, range.start, range.end)
      const offset = Math.max(0, Math.trunc(Number(call.input.offset)) || 0)
      if (offset > 0 && offset >= html.length) {
        return fail(
          t('aiSumReadBlocks'),
          `offset ${offset} is beyond the content (${html.length} characters in total)`,
        )
      }
      const slice = html.slice(offset, offset + READ_MAX_CHARS)
      const end = offset + slice.length
      const note =
        end < html.length
          ? `\n…(truncated: ${html.length} characters in total, call read_blocks again with offset=${end} to continue)`
          : offset > 0
            ? `\n(end of range: ${html.length} characters in total)`
            : ''
      let empty = '(range is empty)'
      if (!slice) {
        let deletedBlocks = 0
        for (let i = range.start; i <= range.end; i++) {
          if (isTrackedDeleted(editor.state.doc.child(i))) deletedBlocks++
        }
        if (deletedBlocks > 0) {
          empty = `(the ${deletedBlocks} block(s) in this range are pending tracked deletions — that text is already deleted and hidden from reads; do not delete or rewrite it again)`
        }
      }
      return {
        output: slice ? slice + note : empty,
        mutated: false,
        summary: t('aiSumReadBlocksRange', { start: range.start, end: range.end }),
      }
    }

    case 'insert_content': {
      const html = String(call.input.html ?? '')
      const echo = toolEchoError(html)
      if (echo) return fail(t('aiSumInsertContent'), echo)
      let nodes: ReturnType<typeof parseHtmlFragment>
      try {
        nodes = parseHtmlFragment(html, numIds)
      } catch (e) {
        return fail(t('aiSumInsertContent'), e instanceof Error ? e.message : String(e))
      }
      if (nodes.length === 0)
        return fail(t('aiSumInsertContent'), 'html did not parse into any content blocks')
      const count = editor.state.doc.childCount
      if (isBlankDocument(editor)) {
        // the blank template's single empty paragraph gets replaced
        replaceBlockRange(editor, 0, count - 1, nodes, track)
        return {
          output: `Inserted ${nodes.length} block(s) (the document was empty). Block indexes have changed; use get_document_context if needed.`,
          mutated: true,
          summary: t('aiSumInsertedBlocks', { count: nodes.length }),
        }
      }
      const cursorScope = call.input.afterBlockIndex === undefined
      const after = cursorScope
        ? getCursorBlockIndex(editor, scope)
        : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1)
      if (!Number.isInteger(after)) return fail(t('aiSumInsertContent'), 'invalid afterBlockIndex')
      // -1 hits blockRangePositions' 0/0 default, i.e. insert at doc start
      insertBlocksAfter(editor, after, nodes, track)
      return {
        output: `Inserted ${nodes.length} block(s) after block ${after}. Subsequent block indexes have shifted; use get_document_context if needed.`,
        mutated: true,
        summary: t('aiSumInsertedBlocks', { count: nodes.length }),
      }
    }

    case 'replace_blocks': {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex)
      if (!range) return fail(t('aiSumReplaceContent'), rangeError(editor))
      const html = String(call.input.html ?? '')
      const echo = toolEchoError(html)
      if (echo) return fail(t('aiSumReplaceContent'), echo)
      let nodes: ReturnType<typeof parseHtmlFragment>
      try {
        nodes = parseHtmlFragment(html, numIds)
      } catch (e) {
        return fail(t('aiSumReplaceContent'), e instanceof Error ? e.message : String(e))
      }
      if (nodes.length === 0)
        return fail(t('aiSumReplaceContent'), 'html did not parse into any content blocks')
      replaceBlockRange(editor, range.start, range.end, nodes, track)
      return {
        output: `Replaced blocks ${range.start}-${range.end} with ${nodes.length} block(s); the new blocks kept the replaced blocks' formatting. Block indexes have changed; use get_document_context if needed.`,
        mutated: true,
        summary: t('aiSumReplacedBlocks', { start: range.start, end: range.end }),
      }
    }

    case 'insert_chart': {
      const kind = String(call.input.kind ?? '') as NewChart['kind']
      if (!['bar', 'line', 'pie'].includes(kind))
        return fail(t('aiSumInsertChart'), 'kind must be one of bar/line/pie')
      const categories = Array.isArray(call.input.categories)
        ? (call.input.categories as unknown[]).map((c) => String(c ?? ''))
        : []
      const seriesIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{ name?: unknown; values?: unknown } | null>)
        : []
      if (!categories.length || !seriesIn.length)
        return fail(t('aiSumInsertChart'), 'categories and series must not be empty')
      const series = seriesIn.map((s, i) => {
        const values: unknown[] = Array.isArray(s?.values) ? s.values : []
        return {
          name: String(s?.name ?? `Series ${i + 1}`),
          values: categories.map((_, j) => {
            const v = values[j] ?? null
            const n = Number(v)
            return v != null && Number.isFinite(n) ? n : null
          }),
        }
      })
      const title = String(call.input.title ?? '').trim() || 'Chart title'
      const spec: NewChart = { kind, title, categories, series }
      const display: ChartDisplay = { partPath: '', kind, title, categories, series }
      const count = editor.state.doc.childCount
      const after =
        call.input.afterBlockIndex === undefined
          ? getCursorBlockIndex(editor, scope)
          : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1)
      if (!Number.isInteger(after)) return fail(t('aiSumInsertChart'), 'invalid afterBlockIndex')
      const { to } = blockRangePositions(editor, after, after)
      editor
        .chain()
        .insertContentAt(to, {
          type: 'docProtected',
          attrs: {
            docxIndex: null,
            blockType: 'chart',
            label: 'Chart',
            genChart: spec,
            chartDisplay: display,
          },
        })
        .run()
      return {
        output: `Inserted a ${kind} chart "${title}" (${categories.length} categories × ${series.length} series).`,
        mutated: true,
        summary: t('aiSumInsertedChart', { title }),
      }
    }

    case 'edit_chart': {
      const idx = Number(call.input.blockIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= editor.state.doc.childCount) {
        return fail(t('aiSumEditChart'), 'blockIndex invalid or out of range')
      }
      const node = editor.state.doc.child(idx)
      // native docx charts are passthrough blocks + chartDisplay; AI/UI-created ones are blockType 'chart'
      const display =
        node.type.name === 'docProtected' ? (node.attrs.chartDisplay as ChartDisplay | null) : null
      if (!display)
        return fail(
          t('aiSumEditChart'),
          `block ${idx} is not a chart (or the chart has no editable data cache)`,
        )
      const isNative = display.partPath !== '' // native chart part from docx: data-point structure is immutable
      const next: ChartDisplay = {
        ...display,
        categories: [...display.categories],
        series: display.series.map((s) => ({ ...s, values: [...s.values] })),
      }
      if (call.input.title !== undefined) next.title = String(call.input.title)
      if (call.input.categories !== undefined) {
        const cats = call.input.categories
        if (!Array.isArray(cats) || cats.length !== display.categories.length) {
          return fail(
            t('aiSumEditChart'),
            `categories must match the original category count (${display.categories.length})`,
          )
        }
        cats.forEach((c, i) => {
          if (c != null) next.categories[i] = String(c)
        })
      }
      const serIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{
            index?: unknown
            name?: unknown
            values?: unknown
          } | null>)
        : []
      for (const s of serIn) {
        const si = Number(s?.index)
        const orig = display.series[si]
        if (!Number.isInteger(si) || !orig)
          return fail(
            t('aiSumEditChart'),
            `series index ${s?.index} is invalid (${display.series.length} series in total)`,
          )
        if (s?.name !== undefined) next.series[si]!.name = String(s.name)
        if (s?.values !== undefined) {
          const values: unknown[] | null = Array.isArray(s.values) ? s.values : null
          if (!values || values.length !== orig.values.length) {
            return fail(
              t('aiSumEditChart'),
              `values of series ${si} must match the original series length (${orig.values.length})`,
            )
          }
          for (let j = 0; j < values.length; j++) {
            const v = values[j]
            if (v == null) continue
            const n = Number(v)
            if (!Number.isFinite(n))
              return fail(t('aiSumEditChart'), `value ${j} of series ${si} is not a number`)
            if (isNative && orig.values[j] == null) {
              return fail(
                t('aiSumEditChart'),
                `data point ${j} of series ${si} is empty in the original chart; empty points of a native chart cannot be written`,
              )
            }
            next.series[si]!.values[j] = n
          }
        }
      }
      // generated charts (genChart) update the spec in sync; the chart part is rebuilt from the new data on save
      const gen = node.attrs.genChart as NewChart | null
      const nextGen: NewChart | null = gen
        ? {
            ...gen,
            title: next.title ?? gen.title,
            categories: [...next.categories],
            series: next.series.map((s) => ({ name: s.name ?? '', values: [...s.values] })),
          }
        : null
      const { from } = blockRangePositions(editor, idx, idx)
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(from, undefined, {
          ...node.attrs,
          chartDisplay: next,
          genChart: nextGen,
        }),
      )
      return {
        output: `Updated the data of chart "${next.title ?? ''}" (changes are written back to the chart on save).`,
        mutated: true,
        summary: t('aiSumEditedChart', { index: idx }),
      }
    }

    case 'insert_table': {
      const headers = Array.isArray(call.input.headers)
        ? (call.input.headers as unknown[]).map((h) => String(h ?? ''))
        : []
      const bodyRows: string[][] = Array.isArray(call.input.rows)
        ? (call.input.rows as unknown[]).map((r) =>
            Array.isArray(r) ? (r as unknown[]).map((c) => String(c ?? '')) : [String(r ?? '')],
          )
        : []
      if (!bodyRows.length && !headers.length)
        return fail(t('aiSumInsertContent'), 'rows must not be empty')
      const cols = Math.max(headers.length, ...bodyRows.map((r) => r.length), 1)
      const preset = TABLE_PRESETS[String(call.input.stylePreset ?? 'none')] ?? TABLE_PRESETS['none']!
      const widthsIn = Array.isArray(call.input.colWidths)
        ? (call.input.colWidths as unknown[]).map((w) => Number(w))
        : []
      const validWidths =
        widthsIn.length === cols && widthsIn.every((n) => Number.isFinite(n) && n > 0)
      const widthSum = validWidths ? widthsIn.reduce((a, b) => a + b, 0) : 0
      const colWidthsPct = validWidths
        ? widthsIn.map((w) => (w / widthSum) * 100)
        : Array.from({ length: cols }, () => 100 / cols)
      const hasHeader = headers.length > 0
      const modelRows: TableCell[][] = []
      if (hasHeader) modelRows.push(tableRowCells(headers, cols, 0, true, preset))
      bodyRows.forEach((r, i) =>
        modelRows.push(tableRowCells(r, cols, hasHeader ? i + 1 : i, false, preset)),
      )
      const line = { style: 'single', szEighths: 4, color: preset.border ? preset.borderColor : 'auto' }
      const table = {
        rows: modelRows,
        colWidthsPct,
        ...(preset.border
          ? { borders: { top: line, bottom: line, left: line, right: line, insideH: line, insideV: line } }
          : {}),
      }
      const count = editor.state.doc.childCount
      const after =
        call.input.afterBlockIndex === undefined
          ? getCursorBlockIndex(editor, scope)
          : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1)
      if (!Number.isInteger(after)) return fail(t('aiSumInsertContent'), 'invalid afterBlockIndex')
      insertBlocksAfter(editor, after, [tableModelToPmNode(table)], track)
      return {
        output: `Inserted a ${modelRows.length}×${cols} table${hasHeader ? ' with a header row' : ''} after block ${after}. Subsequent block indexes shifted; call get_document_context if needed.`,
        mutated: true,
        summary: t('aiSumInsertContent'),
      }
    }

    case 'read_revisions':
      return {
        output: buildRevisionsContext(editor),
        mutated: false,
        summary: t('aiSumReadRevisions'),
      }

    case 'read_comments': {
      if (!comments) return fail(t('aiSumReadComments'), 'comments are not available here')
      return {
        output: buildCommentsContext(editor, comments.list(), true),
        mutated: false,
        summary: t('aiSumReadComments'),
      }
    }

    case 'reply_comment': {
      if (!comments) return fail(t('aiSumReplyComment'), 'comments are not available here')
      const parentId = String(call.input.parentId ?? '').trim()
      const text = String(call.input.text ?? '').trim()
      if (!parentId || !text) {
        return fail(t('aiSumReplyComment'), 'parentId and text must not be empty')
      }
      const target = comments.list().find((c) => c.id === parentId)
      if (!target) {
        return fail(
          t('aiSumReplyComment'),
          `no comment with id ${parentId}; call read_comments for the current ids`,
        )
      }
      const rootId = target.parentId ?? target.id // replies always attach to the thread root
      if (!comments.reply(rootId, text)) {
        return fail(
          t('aiSumReplyComment'),
          'the comment anchor no longer exists in the document; the reply was not added',
        )
      }
      return {
        output: `Replied to comment ${rootId}.`,
        mutated: true, // the reply id joins the anchor marks, so the doc changed
        summary: t('aiSumReplyComment'),
      }
    }

    case 'resolve_comment': {
      if (!comments) return fail(t('aiSumResolveComment'), 'comments are not available here')
      const id = String(call.input.id ?? '').trim()
      const target = comments.list().find((c) => c.id === id)
      if (!target) {
        return fail(
          t('aiSumResolveComment'),
          `no comment with id ${id}; call read_comments for the current ids`,
        )
      }
      const rootId = target.parentId ?? target.id
      if (!comments.resolve(rootId)) {
        return fail(t('aiSumResolveComment'), `comment ${rootId} could not be resolved`)
      }
      return {
        output: `Comment ${rootId} marked as resolved.`,
        mutated: false, // app state only; the document content is untouched
        summary: t('aiSumResolveComment'),
      }
    }

    case 'set_header_footer': {
      const kind = String(call.input.kind ?? '')
      const summaryOf = () => t(kind === 'footer' ? 'aiSumSetFooter' : 'aiSumSetHeader')
      if (!hf) return fail(summaryOf(), 'header/footer editing is not available here')
      if (kind !== 'header' && kind !== 'footer') {
        return fail(summaryOf(), 'kind must be "header" or "footer"')
      }
      const view = call.input.view === undefined ? 'default' : String(call.input.view)
      if (view !== 'default' && view !== 'first' && view !== 'even') {
        return fail(summaryOf(), 'view must be "default", "first" or "even"')
      }
      if (typeof call.input.text !== 'string') return fail(summaryOf(), 'text must be a string')
      const text = call.input.text
      if (text.length > 2000) {
        return fail(summaryOf(), 'text is too long for a header/footer (2000 characters max)')
      }
      const error = hf.set(kind, view, text)
      if (error) return fail(summaryOf(), error)
      return {
        output: `Updated the ${kind}${view !== 'default' ? ` (${view}-page variant)` : ''}.`,
        mutated: false, // app state only, saved with the document; not part of the PM doc
        summary: summaryOf(),
      }
    }

    case 'apply_commands': {
      const commands = call.input.commands
      if (!Array.isArray(commands) || commands.length === 0) {
        return fail(t('aiSumApplyCommands'), 'commands must be a non-empty array')
      }
      const envelope: CommandEnvelope = { commands: commands as Command[] }
      const outcome = executeCommands(editor, envelope, { numIds, track, selection: scope })
      if (!outcome.ok)
        return fail(t('aiSumApplyCommands'), outcome.error ?? 'command execution failed')
      const changed = outcome.results.reduce((sum, r) => sum + r.changed, 0)
      const skippedDeleted = outcome.results.reduce((sum, r) => sum + (r.skippedDeleted ?? 0), 0)
      // explicit model-facing note so it stops retrying deletions of already-deleted text
      const deletedNote =
        skippedDeleted > 0
          ? `\nNote: ${skippedDeleted} matched target(s) were skipped because that text is a pending tracked deletion (already struck through). It is not current content — do not try to delete or replace it again; the user accepts/rejects revisions in the Review tab.`
          : ''
      return {
        output: outcome.summary + deletedNote,
        mutated: changed > 0,
        summary: outcome.summary,
      }
    }

    default:
      return fail(call.name, `unknown tool: ${call.name}`)
  }
}

/** Render the document (or a block range) to a PNG the model can look at. */
async function viewPage(editor: Editor, call: AgentToolCall): Promise<ToolExecution> {
  const root = editor.view.dom as HTMLElement
  const count = editor.state.doc.childCount
  let clip: { x: number; y: number; width: number; height: number } | undefined
  let label = 'the document from the top'
  const hasRange = call.input.startBlockIndex !== undefined || call.input.endBlockIndex !== undefined
  if (hasRange) {
    const range = validRange(
      editor,
      call.input.startBlockIndex ?? 0,
      call.input.endBlockIndex ?? call.input.startBlockIndex ?? 0,
    )
    if (!range) return fail(t('aiSumReadBlocks'), rangeError(editor))
    const rootRect = root.getBoundingClientRect()
    const first = editor.view.nodeDOM(blockRangePositions(editor, range.start, range.start).from) as HTMLElement | null
    const last = editor.view.nodeDOM(blockRangePositions(editor, range.end, range.end).from) as HTMLElement | null
    if (first && last && first.getBoundingClientRect && last.getBoundingClientRect) {
      const a = first.getBoundingClientRect()
      const b = last.getBoundingClientRect()
      clip = {
        x: 0,
        y: Math.max(0, a.top - rootRect.top - 8),
        width: rootRect.width,
        height: Math.max(40, b.bottom - a.top + 16),
      }
      label = `blocks ${range.start}-${range.end}`
    }
  }
  try {
    const scaleIn = Number(call.input.scale)
    const scale = Number.isFinite(scaleIn) && scaleIn > 0 ? Math.min(2, Math.max(0.5, scaleIn)) : 1.25
    const shot = await captureElement(root, { clip, scale, maxHeightCss: 2400 })
    return {
      output: `Captured ${label} (${shot.width}x${shot.height}px${shot.truncated ? ', cut at the capture height limit; pass a block range for more' : ''}; the document has ${count} blocks). Inspect the attached image.`,
      mutated: false,
      summary: t('aiSumReadDocContext'),
      images: [{ base64: shot.base64, mime: 'image/png' }],
      display: { kind: 'images', items: [{ url: `data:image/png;base64,${shot.base64}`, title: `View: ${label}` }] },
    }
  } catch (e) {
    return fail(t('aiSumReadDocContext'), `view_page failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** top-level index of the block containing the caret (doc end as fallback);
 *  a frozen scope wins over the live caret — it is what the prompt described */
function getCursorBlockIndex(editor: Editor, scope?: SelectionScope | null): number {
  if (scope) return Math.min(Math.max(scope.endIndex, 0), editor.state.doc.childCount - 1)
  const { from } = editor.state.selection
  let result = editor.state.doc.childCount - 1
  let index = 0
  editor.state.doc.forEach((node, offset) => {
    if (from >= offset && from <= offset + node.nodeSize) result = index
    index++
  })
  return result
}
