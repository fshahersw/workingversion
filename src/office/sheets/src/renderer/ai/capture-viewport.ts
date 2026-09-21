import { captureElement } from '@/office/shared/capture'

/** Capture the grid and its DOM/SVG drawing layers in their browser paint order.
 * Only the canvas rectangle inside the editor host is returned: no chat pane.
 * html-to-image has no cancellation API; on timeout/abort its read-only work may
 * finish in the background, but its result is discarded and cannot complete a tool. */
export async function captureSheetViewport(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error('Visual capture cancelled')
  const outer = host.getBoundingClientRect()
  const grid = canvas.getBoundingClientRect()
  const left = Math.max(grid.left, outer.left)
  const top = Math.max(grid.top, outer.top)
  const right = Math.min(grid.right, outer.right)
  const bottom = Math.min(grid.bottom, outer.bottom)
  if (right <= left || bottom <= top) throw new Error('The grid viewport is not visible')
  // Guard the full intermediate raster too, not just the final vision image.
  const fullWidth = Math.max(host.scrollWidth, outer.width)
  const fullHeight = Math.max(host.scrollHeight, outer.height)
  if (fullWidth > 4096 || fullHeight > 4096 || fullWidth * fullHeight > 8_000_000) {
    throw new Error('The editor viewport is too large to capture; reduce its visible size and retry')
  }
  const charts = Array.from(host.querySelectorAll<SVGElement>('svg.chart-svg')).filter((chart) => {
    const rect = chart.getBoundingClientRect()
    const style = getComputedStyle(chart)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
  })
  const shot = await new Promise<Awaited<ReturnType<typeof captureElement>>>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: Awaited<ReturnType<typeof captureElement>>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = () => finish(new Error('Visual capture cancelled'))
    const timer = setTimeout(() => finish(new Error('Visual capture timed out; retry with a smaller viewport')), 15_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    captureElement(host, {
      clip: { x: left - outer.left, y: top - outer.top, width: right - left, height: bottom - top },
      scale: 1.25,
      maxHeightCss: 2400,
    }).then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
  return { shot, visibleCharts: charts.length }
}
