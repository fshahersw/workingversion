import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { RenderSlide } from '../../writer/packages/pptx-render/src/render-tree.ts'
import type { QcPageOptions, QcPageResult } from '../../office/slides/src/renderer/ai/slide-qc.ts'

const modulePromise = (async () => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
    entryPoints: ['src/office/slides/src/renderer/ai/slide-qc.ts'],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`) as Promise<{
    qcSlidePage(options: QcPageOptions): Promise<QcPageResult>
    mergeQcPages(previous: number[], mode: string, result: Record<string, number>): number[]
  }>
})()

function requestedSlide(): RenderSlide {
  // Render-space equivalent of x=1in/y=1in/w=7in/h=1in at 96dpi.
  return {
    widthPx: 1280, heightPx: 720, scale: 1,
    nodes: [{ id: 'textbox', sourceId: 'e_title', type: 'text', txBox: true,
      box: { x: 96, y: 96, w: 672, h: 96, rotation: 0 }, fill: { kind: 'none' },
      text: { insets: { l: 0, r: 0, t: 0, b: 0 }, contentHeight: 32, fontScale: 1,
        anchor: 'top', wrap: true, autofit: 'none',
        lines: [{ runs: [{ text: 'Synthetic slide quality check', x: 0, widthPx: 400, fontSizePt: 24, fontSizePx: 32, bold: true, color: '#172E4C' }] }],
      },
    }],
  } as unknown as RenderSlide
}

function freezeDeep(value: object): void {
  Object.freeze(value)
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeDeep(child)
}

test('automatic Slides QC preserves exact requested 24pt navy textbox geometry and never calls a model', async () => {
  const { qcSlidePage } = await modulePromise
  const slides = [requestedSlide()]
  const before = structuredClone(slides)
  freezeDeep(slides)
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('automatic verification must not call a provider') }
  try {
    const result = await qcSlidePage({ access: { getSlides: () => slides }, pageIndex: 0 })
    assert.equal(result.ok, true)
    assert.equal(result.edited, false)
    assert.equal(result.reply, 'OK')
    assert.equal(calls, 0)
    assert.deepEqual(slides, before, 'no 40pt enlargement, recentering, new content or page-size/count change')
  } finally { globalThis.fetch = originalFetch }
})

test('automatic QC reports geometry as advisory without repairing requested or pre-existing composition', async () => {
  const { qcSlidePage } = await modulePromise
  const slide = requestedSlide()
  slide.nodes.push({ ...structuredClone(slide.nodes[0]!), id: 'overlap', sourceId: 'e_overlap' })
  slide.nodes[1]!.box.x = 1120
  slide.nodes.push({ ...structuredClone(slide.nodes[0]!), id: 'intentional-overlay', sourceId: 'e_overlay' })
  const before = structuredClone(slide)
  freezeDeep(slide)
  const result = await qcSlidePage({ access: { getSlides: () => [slide] }, pageIndex: 0 })
  assert.ok(result.findings.some(value => value.startsWith('Out of bounds:')))
  assert.ok(result.findings.some(value => value.startsWith('Overlap:')))
  assert.match(result.reply, /advisory.*requested formatting preserved/)
  assert.equal(result.edited, false)
  assert.equal(result.preIssues, result.postIssues)
  assert.deepEqual(slide, before)
})

test('cancelled checks do not read a new document; generation page bookkeeping stays stable', async () => {
  const { qcSlidePage, mergeQcPages } = await modulePromise
  const result = await qcSlidePage({ access: { getSlides: () => assert.fail('no read after cancellation') }, pageIndex: 0, signal: AbortSignal.abort() })
  assert.equal(result.ok, false)
  assert.equal(result.edited, false)
  assert.deepEqual(mergeQcPages([0, 2], 'insert_at', { insertedIndex: 1 }), [0, 1, 3])
  assert.deepEqual(mergeQcPages([0, 2], 'replace', { pages: 1 }), [0])
})
