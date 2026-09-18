// ============================================================================
// Visual capture helpers for the assistants' view_* tools. A DOM subtree (the
// Writer page, the Sheets grid) is rasterized in the browser with html-to-image
// (SVG foreignObject; no server round trip), optionally clipped to a region,
// then bounded to a size a vision model reads well (long side <= 1568 px).
// Canvas-based editors (Slides) pass an already-rendered canvas/data URL through
// `boundImage` for the same size discipline.
// ============================================================================

export type Capture = { base64: string; width: number; height: number; truncated: boolean };

/** Longest side Anthropic vision models read at full fidelity. */
export const VISION_MAX_SIDE = 1568;

export type CaptureOptions = {
  /** CSS-pixel region inside the element to keep (default: whole element). */
  clip?: { x: number; y: number; width: number; height: number } | undefined;
  /** device-pixel scale applied before bounding (default 1.25) */
  scale?: number | undefined;
  /** cap on the CSS height captured (protects very long documents) */
  maxHeightCss?: number | undefined;
  backgroundColor?: string | undefined;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the capture could not be decoded"));
    img.src = src;
  });
}

/** Bound a canvas to VISION_MAX_SIDE and return PNG base64. */
export function boundCanvas(source: HTMLCanvasElement, maxSide = VISION_MAX_SIDE): Capture {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxSide) {
    const url = source.toDataURL("image/png");
    return { base64: url.slice(url.indexOf(",") + 1), width: source.width, height: source.height, truncated: false };
  }
  const k = maxSide / longest;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(source.width * k));
  out.height = Math.max(1, Math.round(source.height * k));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("canvas is not available");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, out.width, out.height);
  const url = out.toDataURL("image/png");
  return { base64: url.slice(url.indexOf(",") + 1), width: out.width, height: out.height, truncated: false };
}

/** Bound an existing PNG/JPEG data URL (or raw base64) to the vision size. */
export async function boundImage(dataUrlOrBase64: string, mime = "image/png", maxSide = VISION_MAX_SIDE): Promise<Capture> {
  const src = dataUrlOrBase64.startsWith("data:") ? dataUrlOrBase64 : `data:${mime};base64,${dataUrlOrBase64}`;
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas is not available");
  ctx.drawImage(img, 0, 0);
  return boundCanvas(canvas, maxSide);
}

/** Rasterize a DOM element (optionally a clip region) to a bounded PNG. */
export async function captureElement(el: HTMLElement, options: CaptureOptions = {}): Promise<Capture> {
  const { toCanvas } = await import("html-to-image");
  const scale = options.scale ?? 1.25;
  const rect = el.getBoundingClientRect();
  const fullWidth = Math.ceil(el.scrollWidth || rect.width);
  const fullHeight = Math.ceil(el.scrollHeight || rect.height);
  const clip = options.clip ?? { x: 0, y: 0, width: fullWidth, height: fullHeight };
  const maxH = options.maxHeightCss ?? 2400;
  const truncated = clip.height > maxH;
  const cropH = Math.min(clip.height, maxH);
  // Render the whole element once at the requested scale, then crop. Rendering
  // only what is needed vertically keeps very long documents cheap.
  const renderHeight = Math.min(fullHeight, clip.y + cropH);
  const full = await toCanvas(el, {
    pixelRatio: scale,
    backgroundColor: options.backgroundColor ?? "#ffffff",
    width: fullWidth,
    height: renderHeight,
    cacheBust: false,
    // Web-font embedding walks every stylesheet's cssRules; the cross-origin
    // Google Fonts sheet throws and its fallback fetch fails, logging two
    // console errors per capture and costing a network round trip. Document
    // text renders in document fonts (Calibri, Times …), not the UI webfonts,
    // so the captures the model reads are unaffected.
    skipFonts: true,
  });
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(clip.width * scale));
  out.height = Math.max(1, Math.round(cropH * scale));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("canvas is not available");
  ctx.fillStyle = options.backgroundColor ?? "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(
    full,
    Math.round(clip.x * scale),
    Math.round(clip.y * scale),
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  );
  const bounded = boundCanvas(out);
  return { ...bounded, truncated };
}
