// Mermaid diagrams render entirely in the browser: Mermaid produces SVG, the
// SVG is rasterized on a canvas at 2x for crisp placement in a document or
// slide. No network, no server round trip.

const MAX_SOURCE = 60_000;
const MAX_SIDE = 4096;

/**
 * "firm" is the default: Mermaid's `base` theme driven by the Seeger Weiss
 * palette (src/writer/shared/design.ts). Node fills are soft tints with navy
 * text and blue borders so labels stay legible when the PNG lands on a page;
 * lines are slate; the accent (bronze) is reserved for notes, the "today" line
 * and active tasks. Mermaid's stock themes remain selectable by name.
 */
const FIRM = {
  navy: "#172E4C",
  blue: "#1D6294",
  bronze: "#A77D4B",
  ink: "#050F2C",
  slate: "#5F6A7B",
  rule: "#DDE0E4",
  navyTint: "#E2ECF9",
  blueTint: "#D8EBFB",
  blueSoft: "#EAF5FF",
  bronzeTint: "#FCF2E4",
  surface: "#F1F4F7",
  paper: "#FFFFFF",
};

const FIRM_THEME_VARIABLES: Record<string, string> = {
  background: FIRM.paper,
  fontSize: "16px",
  primaryColor: FIRM.blueSoft,
  primaryTextColor: FIRM.ink,
  primaryBorderColor: FIRM.blue,
  secondaryColor: FIRM.navyTint,
  secondaryTextColor: FIRM.ink,
  secondaryBorderColor: FIRM.navy,
  tertiaryColor: FIRM.bronzeTint,
  tertiaryTextColor: FIRM.ink,
  tertiaryBorderColor: FIRM.bronze,
  lineColor: FIRM.slate,
  textColor: FIRM.ink,
  titleColor: FIRM.navy,
  mainBkg: FIRM.blueSoft,
  nodeBorder: FIRM.blue,
  nodeTextColor: FIRM.ink,
  clusterBkg: FIRM.surface,
  clusterBorder: FIRM.rule,
  edgeLabelBackground: FIRM.paper,
  defaultLinkColor: FIRM.slate,
  // sequence
  actorBkg: FIRM.blueSoft,
  actorBorder: FIRM.blue,
  actorTextColor: FIRM.ink,
  actorLineColor: FIRM.rule,
  signalColor: FIRM.navy,
  signalTextColor: FIRM.ink,
  labelBoxBkgColor: FIRM.navyTint,
  labelBoxBorderColor: FIRM.navy,
  labelTextColor: FIRM.ink,
  loopTextColor: FIRM.ink,
  noteBkgColor: FIRM.bronzeTint,
  noteBorderColor: FIRM.bronze,
  noteTextColor: FIRM.ink,
  activationBkgColor: FIRM.blueTint,
  activationBorderColor: FIRM.blue,
  sequenceNumberColor: FIRM.paper,
  // gantt
  sectionBkgColor: FIRM.surface,
  sectionBkgColor2: FIRM.paper,
  altSectionBkgColor: FIRM.paper,
  gridColor: FIRM.rule,
  taskBkgColor: FIRM.blue,
  taskBorderColor: FIRM.navy,
  taskTextColor: FIRM.paper,
  taskTextLightColor: FIRM.paper,
  taskTextDarkColor: FIRM.ink,
  taskTextOutsideColor: FIRM.ink,
  activeTaskBkgColor: FIRM.bronze,
  activeTaskBorderColor: FIRM.bronze,
  doneTaskBkgColor: FIRM.navyTint,
  doneTaskBorderColor: FIRM.navy,
  critBkgColor: FIRM.bronzeTint,
  critBorderColor: FIRM.bronze,
  todayLineColor: FIRM.bronze,
  // state / class / er
  transitionColor: FIRM.slate,
  transitionLabelColor: FIRM.ink,
  stateLabelColor: FIRM.ink,
  stateBkg: FIRM.blueSoft,
  labelBackgroundColor: FIRM.paper,
  compositeBackground: FIRM.surface,
  compositeTitleBackground: FIRM.navyTint,
  compositeBorder: FIRM.rule,
  classText: FIRM.ink,
  attributeBackgroundColorOdd: FIRM.paper,
  attributeBackgroundColorEven: FIRM.surface,
  // pie / timeline / quadrant scales
  pie1: FIRM.navy,
  pie2: FIRM.blue,
  pie3: FIRM.bronze,
  pie4: FIRM.slate,
  pie5: FIRM.blueTint,
  pie6: FIRM.navyTint,
  pie7: FIRM.bronzeTint,
  pie8: FIRM.rule,
  pieTitleTextColor: FIRM.navy,
  pieSectionTextColor: FIRM.paper,
  pieStrokeColor: FIRM.paper,
  pieOuterStrokeColor: FIRM.rule,
  cScale0: FIRM.navy,
  cScale1: FIRM.blue,
  cScale2: FIRM.bronze,
  cScale3: FIRM.slate,
  cScale4: FIRM.blueTint,
  cScale5: FIRM.navyTint,
  cScale6: FIRM.bronzeTint,
  cScale7: FIRM.surface,
  cScaleLabel0: FIRM.paper,
  cScaleLabel1: FIRM.paper,
  cScaleLabel2: FIRM.paper,
  cScaleLabel3: FIRM.paper,
  cScaleLabel4: FIRM.ink,
  cScaleLabel5: FIRM.ink,
  cScaleLabel6: FIRM.ink,
  cScaleLabel7: FIRM.ink,
  quadrant1Fill: FIRM.blueSoft,
  quadrant2Fill: FIRM.navyTint,
  quadrant3Fill: FIRM.surface,
  quadrant4Fill: FIRM.bronzeTint,
  quadrantPointFill: FIRM.navy,
  quadrantPointTextFill: FIRM.ink,
  quadrantXAxisTextFill: FIRM.slate,
  quadrantYAxisTextFill: FIRM.slate,
  quadrantTitleFill: FIRM.navy,
  quadrantInternalBorderStrokeFill: FIRM.rule,
  quadrantExternalBorderStrokeFill: FIRM.rule,
  // git / journey / misc text
  git0: FIRM.navy,
  git1: FIRM.blue,
  git2: FIRM.bronze,
  git3: FIRM.slate,
  fillType0: FIRM.blueSoft,
  fillType1: FIRM.navyTint,
  fillType2: FIRM.bronzeTint,
  fillType3: FIRM.surface,
};

export const MERMAID_THEMES = ["firm", "default", "neutral", "forest", "dark", "base"] as const;
export type MermaidTheme = (typeof MERMAID_THEMES)[number];
export const DEFAULT_MERMAID_THEME: MermaidTheme = "firm";

const THEMES = new Set<string>(MERMAID_THEMES);
let initializedTheme: string | null = null;

export async function renderMermaidPng(
  source: string,
  options: { scale?: number; theme?: string | undefined } = {},
): Promise<{ base64: string; width: number; height: number; svg: string }> {
  if (!source.trim()) throw new Error("Diagram source is empty.");
  if (source.length > MAX_SOURCE) throw new Error("Diagram source is too long.");
  const { default: mermaid } = await import("mermaid");
  const theme = options.theme && THEMES.has(options.theme) ? options.theme : DEFAULT_MERMAID_THEME;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "firm" ? "base" : theme,
      ...(theme === "firm" ? { themeVariables: FIRM_THEME_VARIABLES } : {}),
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

  // 3x keeps 16px labels crisp when the PNG is placed at page width and printed.
  const scale = Math.min(options.scale ?? 3, MAX_SIDE / Math.max(width, height));
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
