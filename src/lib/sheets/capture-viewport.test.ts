import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'

const source = await readFile(new URL('../../office/sheets/src/renderer/ai/capture-viewport.ts', import.meta.url), 'utf8')
const code = (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code
  .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
let number = 0
async function captureWith(captureElement: (...args: any[]) => Promise<unknown>, fastTimeout = false) {
  const name = `__sheetsCapture${number++}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[name] = {
    captureElement,
    getComputedStyle: (el: any) => ({ display: 'block', visibility: 'visible', opacity: '1', ...el.style }),
    setTimeout: fastTimeout ? (callback: () => void) => setTimeout(callback, 1) : setTimeout,
  }
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(`const { captureElement, getComputedStyle, setTimeout } = globalThis.${name};\n${code}`).toString('base64')}`)
    return module.captureSheetViewport
  } finally { delete globals[name] }
}
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height })
const chart = (bounds: ReturnType<typeof rect>, style = {}) => ({ getBoundingClientRect: () => bounds, style })
const host = (charts: unknown[] = [], width = 1000, height = 800) => ({
  scrollWidth: width, scrollHeight: height,
  getBoundingClientRect: () => rect(100, 50, width, height),
  querySelectorAll: (selector: string) => { assert.equal(selector, 'svg.chart-svg'); return charts },
})
const grid = { getBoundingClientRect: () => rect(100, 150, 950, 650) }
const image = { base64: 'synthetic', width: 1188, height: 813, truncated: false }

test('captures the editor DOM including chart layers, clipped to the grid rather than toolbar or chat', async () => {
  const editor = host([
    chart(rect(200, 250, 400, 300)), chart(rect(1200, 100, 400, 300)),
    chart(rect(200, 250, 400, 300), { display: 'none' }),
  ])
  let captured: unknown
  const capture = await captureWith(async (element, options) => {
    captured = element
    assert.deepEqual(options.clip, { x: 0, y: 100, width: 950, height: 650 })
    assert.equal(options.maxHeightCss, 2400)
    return image
  })
  const result = await capture(editor, grid)
  assert.equal(captured, editor, 'capture the DOM containing SVG overlays, not the bare grid canvas')
  assert.equal(result.visibleCharts, 1)
  assert.deepEqual(result.shot, image)
})

test('offscreen grid and oversized intermediate raster fail before invoking the rasterizer', async () => {
  let calls = 0
  const capture = await captureWith(async () => { calls++; return image })
  await assert.rejects(capture(host(), { getBoundingClientRect: () => rect(2000, 2000, 500, 500) }), /not visible/)
  await assert.rejects(capture(host([], 5000, 800), grid), /too large/)
  assert.equal(calls, 0)
})

test('cancelled and failed DOM captures cannot silently fall back to a chart-free success image', async () => {
  const controller = new AbortController()
  let finish: (value: unknown) => void = () => {}
  const capture = await captureWith(() => new Promise((resolve) => { finish = resolve }))
  const pending = capture(host(), grid, controller.signal)
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  finish(image)
  await assert.rejects(capture(host(), grid, controller.signal), /cancelled/)
  const failed = await captureWith(async () => { throw new Error('SVG rasterization failed') })
  await assert.rejects(failed(host(), grid), /SVG rasterization failed/)
})

test('an unresponsive rasterizer has a bounded deadline', async () => {
  const capture = await captureWith(() => new Promise(() => {}), true)
  await assert.rejects(capture(host(), grid), /timed out/)
})

test('view_range is serialized because moving the active sheet and viewport is shared state', async () => {
  const source = await readFile(new URL('../../office/sheets/src/renderer/ai/view-skill.ts', import.meta.url), 'utf8')
  const code = (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const skill = module.createViewSkill({})
  assert.equal(skill.tools.find((tool: { name: string }) => tool.name === 'view_range').readOnly, false)
})
