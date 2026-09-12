/**
 * design_slide_html: the model writes one slide as constrained HTML/CSS (a
 * 1280x720 canvas), the browser lays it out in a sandboxed offscreen iframe,
 * and the laid-out boxes are transpiled into the native PageSpec (text boxes,
 * shapes, http(s) images) that the local generator turns into an editable
 * PPTX slide. HTML is the design scratchpad; PPTX is the target. Nothing from
 * the HTML runs: scripts, event handlers and external resources are stripped.
 */
import type { AgentSkill, AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import type { DeckAccess } from './slides-skill'
import { auditSlideLayout } from './layout-audit'

const CANVAS_W = 1280
const CANVAS_H = 720
const MAX_ELEMENTS = 48
const MAX_HTML = 60_000
const LAYOUT_WAIT_MS = 900

type SpecRun = { text: string; sizePt?: number; bold?: boolean; italic?: boolean; color?: string; font?: string }
type SpecParagraph = { runs: SpecRun[]; align?: 'left' | 'center' | 'right' | 'justify'; bullet?: boolean; lineSpacingPct?: number }
type SpecElement =
  | { type: 'text'; x: number; y: number; w: number; h: number; paragraphs: SpecParagraph[]; valign?: 'top' | 'middle' | 'bottom' }
  | { type: 'shape'; shape: string; x: number; y: number; w: number; h: number; fill?: string; stroke?: { color: string; widthPt: number }; paragraphs?: SpecParagraph[]; valign?: 'top' | 'middle' | 'bottom' }
  | { type: 'image'; url: string; x: number; y: number; w: number; h: number }

const INLINE_TAGS = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'SUP', 'SUB', 'SMALL', 'CODE', 'MARK', 'BR', 'LABEL', 'TIME', 'ABBR'])

function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\((?!\s*['"]?https?:)[^)]*\)/gi, 'none')
}

/** rgb()/rgba() → #RRGGBB, or undefined when transparent. */
function hexOf(css: string): string | undefined {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(css)
  if (!m) return undefined
  const a = m[4] === undefined ? 1 : Number(m[4])
  if (a < 0.05) return undefined
  const h = (n: string) => Number(n).toString(16).padStart(2, '0').toUpperCase()
  return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`
}

function fontOf(family: string): string | undefined {
  const first = family.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  if (!first) return undefined
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'inherit'])
  return generic.has(first.toLowerCase()) ? undefined : first
}

function isBlockLike(display: string): boolean {
  return !display.startsWith('inline') && display !== 'contents'
}

/** True when the element carries text but no block-level children (a text box). */
function isTextLeaf(el: Element, view: Window): boolean {
  let hasText = false
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent && child.textContent.trim()) hasText = true
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child as Element
      if (c.tagName === 'IMG') return false
      const disp = view.getComputedStyle(c).display
      if (isBlockLike(disp) && !INLINE_TAGS.has(c.tagName)) return false
      if (c.textContent && c.textContent.trim()) hasText = true
    }
  }
  return hasText
}

function runsOf(el: Element, view: Window, inherited: SpecRun): SpecRun[] {
  const out: SpecRun[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\s+/g, ' ')
      if (text.trim()) out.push({ ...inherited, text })
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child as Element
      if (c.tagName === 'BR') {
        out.push({ ...inherited, text: '\n' })
        continue
      }
      const cs = view.getComputedStyle(c)
      const style: SpecRun = {
        ...inherited,
        text: '',
        ...(Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold' ? { bold: true } : {}),
        ...(cs.fontStyle === 'italic' ? { italic: true } : {}),
        ...(hexOf(cs.color) ? { color: hexOf(cs.color) } : {}),
        ...(fontOf(cs.fontFamily) ? { font: fontOf(cs.fontFamily) } : {}),
        sizePt: Math.round((parseFloat(cs.fontSize) || 16) * 0.75 * 2) / 2,
      }
      out.push(...runsOf(c, view, style))
    }
  }
  return out
}

function paragraphsOf(el: Element, view: Window): SpecParagraph[] {
  const cs = view.getComputedStyle(el)
  const base: SpecRun = {
    text: '',
    sizePt: Math.round((parseFloat(cs.fontSize) || 16) * 0.75 * 2) / 2,
    ...(Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold' ? { bold: true } : {}),
    ...(cs.fontStyle === 'italic' ? { italic: true } : {}),
    ...(hexOf(cs.color) ? { color: hexOf(cs.color) } : {}),
    ...(fontOf(cs.fontFamily) ? { font: fontOf(cs.fontFamily) } : {}),
  }
  const alignRaw = cs.textAlign
  const align = alignRaw === 'center' || alignRaw === 'right' || alignRaw === 'justify' ? alignRaw : alignRaw === 'left' || alignRaw === 'start' ? 'left' : undefined
  const lh = parseFloat(cs.lineHeight)
  const fs = parseFloat(cs.fontSize) || 16
  const lineSpacingPct = Number.isFinite(lh) && lh > 0 ? Math.round(Math.min(300, Math.max(60, (lh / fs) * 100))) : undefined
  const runs = runsOf(el, view, base)
  // Split on explicit line breaks into paragraphs so PowerPoint keeps them.
  const paragraphs: SpecParagraph[] = []
  let current: SpecRun[] = []
  for (const r of runs) {
    if (r.text === '\n') {
      if (current.length) paragraphs.push({ runs: current, ...(align ? { align } : {}), ...(lineSpacingPct ? { lineSpacingPct } : {}) })
      current = []
    } else current.push(r)
  }
  if (current.length) paragraphs.push({ runs: current, ...(align ? { align } : {}), ...(lineSpacingPct ? { lineSpacingPct } : {}) })
  const bullet = el.tagName === 'LI' && cs.listStyleType !== 'none'
  return bullet ? paragraphs.map((p) => ({ ...p, bullet: true })) : paragraphs
}

/** Walk the laid-out document and emit PageSpec elements in paint order. */
function transpile(doc: Document, view: Window): { elements: SpecElement[]; background?: string; warnings: string[] } {
  const warnings: string[] = []
  const elements: SpecElement[] = []
  const bodyCs = view.getComputedStyle(doc.body)
  const background = hexOf(bodyCs.backgroundColor) ?? hexOf(view.getComputedStyle(doc.documentElement).backgroundColor)
  const consumed = new Set<Element>()

  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const visible = (el: Element, cs: CSSStyleDeclaration, r: { x: number; y: number; w: number; h: number }) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && r.w >= 2 && r.h >= 2 && r.x < CANVAS_W && r.y < CANVAS_H && r.x + r.w > 0 && r.y + r.h > 0

  const push = (el: SpecElement) => {
    if (elements.length >= MAX_ELEMENTS) {
      if (!warnings.includes('element cap reached')) warnings.push('element cap reached')
      return
    }
    elements.push(el)
  }

  const walk = (el: Element) => {
    if (consumed.has(el)) return
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'HEAD') return
    const cs = view.getComputedStyle(el)
    const r = rectOf(el)
    if (!visible(el, cs, r)) return

    // Boxes: background fill or border become a shape behind the content.
    if (el !== doc.body) {
      const fill = hexOf(cs.backgroundColor)
      const bw = parseFloat(cs.borderTopWidth) || 0
      const strokeColor = bw > 0 ? hexOf(cs.borderTopColor) : undefined
      const bgImage = /url\(\s*['"]?https?:/i.exec(cs.backgroundImage)
      if (bgImage) {
        const m = /url\(\s*['"]?(https?:[^'")]+)/i.exec(cs.backgroundImage)
        if (m) push({ type: 'image', url: m[1]!, ...r })
      }
      if (fill || strokeColor) {
        const radius = parseFloat(cs.borderTopLeftRadius) || 0
        const shape = radius >= Math.min(r.w, r.h) / 2 - 1 ? 'ellipse' : radius > 2 ? 'roundRect' : 'rect'
        push({
          type: 'shape',
          shape,
          ...r,
          ...(fill ? { fill } : {}),
          ...(strokeColor ? { stroke: { color: strokeColor, widthPt: Math.min(24, Math.max(0.25, bw * 0.75)) } } : {}),
        })
      }
    }

    if (el.tagName === 'IMG') {
      const src = (el as HTMLImageElement).getAttribute('src') ?? ''
      if (/^https?:\/\//i.test(src)) push({ type: 'image', url: src, ...r })
      else warnings.push(`image "${src.slice(0, 40)}" skipped: only http(s) URLs land; place platform images afterwards with insert_web_image`)
      return
    }

    // Lists: one text box with bullet paragraphs.
    if ((el.tagName === 'UL' || el.tagName === 'OL') && Array.from(el.children).every((c) => c.tagName === 'LI')) {
      const paragraphs = Array.from(el.children).flatMap((li) => {
        consumed.add(li)
        return isTextLeaf(li, view) ? paragraphsOf(li, view) : []
      })
      if (paragraphs.length) push({ type: 'text', ...r, paragraphs, valign: 'top' })
      return
    }

    if (isTextLeaf(el, view)) {
      const paragraphs = paragraphsOf(el, view)
      if (paragraphs.some((p) => p.runs.some((x) => x.text.trim()))) {
        const jc = cs.justifyContent
        const ai = cs.alignItems
        const flexCol = cs.display.includes('flex') && cs.flexDirection.startsWith('column')
        const v = flexCol ? jc : ai
        const valign: 'top' | 'middle' | 'bottom' = /center/.test(v) ? 'middle' : /end/.test(v) ? 'bottom' : 'top'
        push({ type: 'text', ...r, paragraphs, valign })
      }
      return
    }
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(doc.body)
  return { elements, ...(background ? { background } : {}), warnings }
}

async function layout(html: string, css: string): Promise<{ elements: SpecElement[]; background?: string; warnings: string[] }> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px;border:0;visibility:hidden;pointer-events:none`
  document.body.appendChild(iframe)
  try {
    const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${CANVAS_W}px;height:${CANVAS_H}px;overflow:hidden;font-family:Calibri,Carlito,Arial,sans-serif;font-size:18px;color:#182838}*{box-sizing:border-box}${sanitize(css)}</style></head><body>${sanitize(html)}</body></html>`
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve()
      iframe.srcdoc = srcdoc
      setTimeout(resolve, 2500)
    })
    const doc = iframe.contentDocument
    const view = iframe.contentWindow
    if (!doc || !view) throw new Error('the layout frame is not available')
    await Promise.race([(doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS))])
    await new Promise((r) => setTimeout(r, 60))
    return transpile(doc, view)
  } finally {
    iframe.remove()
  }
}

const HTML_GUIDE = `## Designing a slide in HTML (design_slide_html)
- Write one slide as HTML + CSS on a fixed 1280x720 px canvas (body is the slide). Use absolutely or flex-positioned <div>s with explicit widths; every visible box becomes a native, editable PowerPoint element: text blocks become text boxes (font size, weight, color, alignment, line height kept; <ul>/<li> become bullet paragraphs), elements with background-color or border become shapes (border-radius gives rounded corners or circles), <img src="https://..."> and CSS background-image URLs become pictures. Gradients, shadows, transforms, SVG and icon fonts do not transfer; use flat fills and real text.
- Keep text inside its box (PowerPoint has no overflow); prefer 16-20 elements per slide, never more than 48. Titles 28-42pt (37-56px), body 18-24pt (24-32px).
- Set the slide background on body (background-color). Fonts: Calibri/Carlito, Georgia, Arial are safe.
- After landing, run audit_layout and view_slide; fix issues with apply_ops or by designing the slide again with mode "replace_slide".`

export function createHtmlDesignSkill(access: DeckAccess): AgentSkill {
  const fail = (output: string): ToolExecution => ({ output, isError: true, mutated: false, summary: 'Design slide' })
  return {
    id: 'html-design',
    systemPrompt: HTML_GUIDE,
    tools: [
      {
        name: 'design_slide_html',
        description:
          'Design one slide as HTML/CSS on a 1280x720 canvas and land it as a native, editable slide (text boxes, shapes, pictures; no HTML is stored). mode "append" adds it at the end (default), "insert_at" puts it at slideIndex, "replace_slide" redesigns the slide at slideIndex in place, "replace" starts a new one-slide deck. Use it for custom layouts the template library cannot express (dashboards, hero pages, comparison grids). Afterwards check with audit_layout and view_slide.',
        inputSchema: {
          type: 'object',
          properties: {
            html: { type: 'string', description: 'Body HTML of the slide (no <html>/<body>, no scripts).' },
            css: { type: 'string', description: 'Optional stylesheet rules.' },
            title: { type: 'string', description: 'Deck name when creating a new deck (mode replace).' },
            mode: { type: 'string', enum: ['append', 'insert_at', 'replace_slide', 'replace'] },
            slideIndex: { type: 'integer', minimum: 0, description: '0-based index for insert_at / replace_slide' },
          },
          required: ['html'],
        },
      },
    ],
    executeTool: async (call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> => {
      if (call.name !== 'design_slide_html') return fail(`Unknown tool: ${call.name}`)
      const html = String(call.input.html ?? '')
      const css = String(call.input.css ?? '')
      if (!html.trim()) return fail('html must not be empty')
      if (html.length + css.length > MAX_HTML) return fail(`html+css must stay under ${MAX_HTML} characters`)
      if (!access.landGeneratedPages) return fail('The local slide generator is not ready.')
      const mode = String(call.input.mode ?? 'append')
      const idxRaw = call.input.slideIndex
      const slideCount = access.getSlides().length
      let index: number | undefined
      if (mode === 'insert_at' || mode === 'replace_slide') {
        index = Number(idxRaw)
        if (!Number.isInteger(index) || index < 0 || index > (mode === 'insert_at' ? slideCount : slideCount - 1)) return fail(`slideIndex must be 0-${mode === 'insert_at' ? slideCount : Math.max(0, slideCount - 1)} for ${mode}`)
      }
      try {
        const laid = await layout(html, css)
        signal?.throwIfAborted()
        if (!laid.elements.length) return fail('The HTML produced no visible elements. Give boxes explicit sizes and text.')
        const spec = { ...(laid.background ? { background: laid.background } : {}), elements: laid.elements }
        const result = await window.slidesApi.localGeneratePage({ specJson: JSON.stringify(spec) })
        if (!result.ok || !result.marker) return fail(result.error || 'The slide could not be built from the layout.')
        signal?.throwIfAborted()
        let landed: { ok: boolean; error?: string; pages?: number; insertedIndex?: number; appendedFrom?: number; imageFailures?: { page: number; url: string }[] }
        let landedIndex: number
        if (mode === 'replace_slide' && index !== undefined) {
          if (!access.regenerateSlide) return fail('Replacing a slide in place is not available here; use mode insert_at.')
          landed = await access.regenerateSlide(index, result.marker)
          landedIndex = index
        } else if (mode === 'insert_at' && index !== undefined) {
          landed = await access.landGeneratedPages([result.marker], 'insert_at', undefined, index)
          landedIndex = landed.insertedIndex ?? index
        } else if (mode === 'replace') {
          landed = await access.landGeneratedPages([result.marker], 'replace', String(call.input.title ?? '').trim() || undefined)
          landedIndex = 0
        } else {
          landed = await access.landGeneratedPages([result.marker], 'append')
          landedIndex = landed.appendedFrom ?? Math.max(0, access.getSlides().length - 1)
        }
        if (!landed.ok) return fail(landed.error || 'The slide could not be inserted.')
        const slide = access.getSlides()[landedIndex]
        const issues = slide ? auditSlideLayout(slide) : []
        const notes = [
          ...laid.warnings,
          ...(landed.imageFailures?.length ? [`images failed to download: ${landed.imageFailures.map((f) => f.url).join(', ')}`] : []),
        ]
        return {
          mutated: true,
          summary: mode === 'replace_slide' ? `Redesigned slide ${landedIndex + 1}` : `Designed slide ${landedIndex + 1}`,
          output: `Landed slide ${landedIndex + 1} with ${laid.elements.length} native elements (${access.getSlides().length} slides in the deck).${issues.length ? ` Layout findings: ${issues.join('; ')}.` : ''}${notes.length ? ` Notes: ${notes.join('; ')}.` : ''} Run view_slide to confirm the look.`,
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'The slide design could not complete.')
      }
    },
  }
}
