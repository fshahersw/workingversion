// Mermaid diagrams render entirely in the browser: Mermaid produces SVG, the
// SVG is rasterized on a canvas at 2x for crisp placement in a document or
// slide. No network, no server round trip.

const MAX_SOURCE = 60_000;
const MAX_SIDE = 4096;

const THEMES = new Set(["default", "neutral", "forest", "dark", "base"]);
let initializedTheme: string | null = null;

export async function renderMermaidPng(
  source: string,
  options: { scale?: number; theme?: string | undefined } = {},
): Promise<{ base64: string; width: number; height: number; svg: string }> {
  if (!source.trim()) throw new Error("Diagram source is empty.");
  if (source.length > MAX_SOURCE) throw new Error("Diagram source is too long.");
  const { default: mermaid } = await import("mermaid");
  const theme = options.theme && THEMES.has(options.theme) ? options.theme : "neutral";
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "Calibri, Carlito, Arial, sans-serif",
      // HTML labels wrap text in <foreignObject>, which taints the canvas and
      // blocks PNG export; plain SVG text labels rasterize cleanly.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
      state: { htmlLabels: false },
      er: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    } as Parameters<typeof mermaid.initialize>[0]);
    initializedTheme = theme;
  }
  const id = "sw-mermaid-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const { svg } = await mermaid.render(id, source);

  // Mermaid emits a viewBox and often percentage widths; pin explicit pixel
  // dimensions so the rasterizer knows the canvas size.
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") throw new Error("Mermaid did not return an SVG.");
  // Mermaid emits width="100%" (a percentage, not pixels) with the real size in
  // the viewBox; only trust absolute pixel attributes.
  const px = (attr: string | null) => (attr && !attr.includes("%") ? Number.parseFloat(attr) : NaN);
  const viewBox = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  let width = px(root.getAttribute("width"));
  let height = px(root.getAttribute("height"));
  if (viewBox.length === 4 && viewBox.every((n) => Number.isFinite(n))) {
    if (!Number.isFinite(width) || width <= 0) width = viewBox[2]!;
    if (!Number.isFinite(height) || height <= 0) height = viewBox[3]!;
  }
  if (!Number.isFinite(width) || width <= 0) width = 1200;
  if (!Number.isFinite(height) || height <= 0) height = 700;
  width = Math.ceil(width);
  height = Math.ceil(height);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const serialized = new XMLSerializer().serializeToString(root);

  const scale = Math.min(options.scale ?? 2, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The diagram SVG could not be rasterized."));
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  const dataUrl = canvas.toDataURL("image/png");
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), width: canvas.width, height: canvas.height, svg: serialized };
}
