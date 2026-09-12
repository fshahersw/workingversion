// ============================================================================
// Server-executed capabilities for the Office assistants (Writer, Sheets,
// Slides). The editors' own tools run in the browser against the open
// document; these run on the platform and give the same agents the Research
// agent's heavier machinery:
//   - Python in the AgentCore code interpreter (no network egress) for exact
//     calculations, data reshaping and matplotlib figures
//   - Graphviz rendering (DOT -> PNG) in the same sandbox
//   - Image generation with Amazon Nova Canvas on Bedrock
//   - Reporter-citation verification against CourtListener
//   - Reading a public web page in full (SSRF-hardened fetcher)
//   - Cross-app document creation (markdown -> DOCX/XLSX/PDF via docgen,
//     markdown outline -> PPTX via pptx-engine) saved into the Library
// Nothing here touches the open document; results flow back to the browser
// tool, which decides how to place them.
// ============================================================================
import { signedBedrockFetch } from "@/lib/agents/bedrock-sign.server";
import {
  collectNewArtifacts,
  getFile,
  markSeen,
  runPython,
  writeFile,
} from "@/lib/agents/code-interpreter.server";
import { courtlistenerConfigured, lookupCitations } from "@/lib/agents/courtlistener.server";
import { generateDocument } from "@/lib/agents/docgen.server";
import { fetchPage } from "@/lib/agents/fetch-page.server";

import { createOfficeDoc } from "./office.server";
import type { OfficeDocSummary } from "./types";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";

export class OfficeToolError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ToolImage = { mime: "image/png" | "image/jpeg"; base64: string };

// --- Python -------------------------------------------------------------------------------------

export const MAX_PYTHON_CODE = 40_000;
const MAX_TOOL_TEXT = 24_000;
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 6_000_000;

export type PythonResult = {
  text: string;
  images: ToolImage[];
  files: Array<{ name: string; size: number; base64: string | null }>;
  isError: boolean;
};

/**
 * Run a Python snippet. Figures the code saves as PNG (or shows through
 * matplotlib) and any other new files come back so the browser tool can
 * place or offer them. Output text is bounded; the sandbox has no network.
 */
export async function runOfficePython(code: string): Promise<PythonResult> {
  if (typeof code !== "string" || !code.trim()) throw new OfficeToolError(422, "code is required.");
  if (code.length > MAX_PYTHON_CODE) throw new OfficeToolError(413, "The code is too long.");
  // Non-interactive backend so plt.show() yields an image instead of blocking.
  const prelude = "import matplotlib\nmatplotlib.use('Agg')\n";
  const result = await runPython(prelude + code);
  const images: ToolImage[] = result.images
    .filter((b) => typeof b === "string" && b.length <= MAX_IMAGE_B64)
    .slice(0, MAX_IMAGES)
    .map((base64) => ({ mime: "image/png" as const, base64 }));
  const files: PythonResult["files"] = [];
  try {
    for (const f of await collectNewArtifacts()) {
      if (/\.(png|jpe?g)$/i.test(f.name) && f.dataB64 && images.length < MAX_IMAGES) {
        images.push({
          mime: /\.png$/i.test(f.name) ? "image/png" : "image/jpeg",
          base64: f.dataB64,
        });
      } else {
        files.push({ name: f.name, size: f.size, base64: f.dataB64 });
      }
    }
  } catch {
    /* artifact listing is best effort */
  }
  const text = result.text.length > MAX_TOOL_TEXT ? result.text.slice(0, MAX_TOOL_TEXT) + "\n[output truncated]" : result.text;
  return { text, images, files, isError: result.isError };
}

// --- Diagrams -------------------------------------------------------------------------------------

export const MAX_DIAGRAM_SOURCE = 60_000;

/** Render Graphviz DOT to PNG in the sandbox (graphviz is preinstalled there). */
export async function renderGraphviz(source: string, engine = "dot"): Promise<ToolImage> {
  if (typeof source !== "string" || !source.trim()) throw new OfficeToolError(422, "source is required.");
  if (source.length > MAX_DIAGRAM_SOURCE) throw new OfficeToolError(413, "The diagram source is too long.");
  const layout = ["dot", "neato", "fdp", "sfdp", "circo", "twopi"].includes(engine) ? engine : "dot";
  const name = `sw_diagram_${Date.now().toString(36)}.png`;
  await writeFile("sw_diagram.dot", source);
  const code = [
    "import graphviz",
    `src = graphviz.Source(open('sw_diagram.dot', encoding='utf-8').read(), engine=${JSON.stringify(layout)}, format='png')`,
    "src.graph_attr = {}",
    `data = src.pipe()`,
    `open(${JSON.stringify(name)}, 'wb').write(data)`,
    `print('<<OK>>' + str(len(data)) + '<<END>>')`,
  ].join("\n");
  const result = await runPython(code);
  if (result.isError || !/<<OK>>\d+<<END>>/.test(result.text)) {
    throw new OfficeToolError(
      422,
      `Graphviz could not render the diagram: ${result.text.replace(/\s+/g, " ").slice(-400) || "unknown error"}`,
    );
  }
  markSeen(name);
  const base64 = await getFile(name);
  if (!base64) throw new OfficeToolError(502, "The rendered diagram could not be read back.");
  return { mime: "image/png", base64 };
}

// --- Image generation (Bedrock: Stability Image Core/Ultra/SD3.5 or Amazon Nova Canvas) ---------------------

/**
 * Text-to-image model. Stability's models are the active text-to-image models
 * in this account (us-west-2); Nova Canvas is accepted too. Both are invoked
 * through Bedrock InvokeModel with SigV4; the request/response shapes differ.
 */
export const IMAGE_MODEL = process.env["OFFICE_IMAGE_MODEL"] || "stability.stable-image-core-v1:1";
const IMAGE_REGION =
  process.env["OFFICE_IMAGE_REGION"] || (IMAGE_MODEL.startsWith("stability.") ? "us-west-2" : REGION);

/** Nova Canvas sizes: multiples of 16, 320..4096 per side, at most 4.19M pixels. */
const IMAGE_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
};
/** Stability accepts a fixed set of aspect ratios; 4:3 and 3:4 map to their nearest supported ratio. */
const STABILITY_RATIOS: Record<string, string> = {
  "1:1": "1:1",
  "16:9": "16:9",
  "9:16": "9:16",
  "4:3": "5:4",
  "3:4": "4:5",
  "3:2": "3:2",
  "2:3": "2:3",
};

export function imageGenerationEnabled(): boolean {
  return (process.env["OFFICE_IMAGE_GEN"] ?? "on").toLowerCase() !== "off";
}

/** Read PNG/JPEG dimensions from the bytes (Stability does not report them). */
function imageDimensions(base64: string): { width: number; height: number } | null {
  const b = Buffer.from(base64.slice(0, 200_000), "base64");
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export async function generateOfficeImage(input: {
  prompt: string;
  aspectRatio?: string;
  negativePrompt?: string;
  signal?: AbortSignal;
}): Promise<ToolImage & { width: number; height: number }> {
  if (!imageGenerationEnabled()) throw new OfficeToolError(501, "Image generation is disabled.");
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new OfficeToolError(422, "prompt is required.");
  if (prompt.length > 1024) throw new OfficeToolError(413, "Prompt must be 1024 characters or fewer.");
  const ratio = IMAGE_SIZES[input.aspectRatio ?? "1:1"] ? (input.aspectRatio ?? "1:1") : "1:1";
  const size = IMAGE_SIZES[ratio]!;
  // Diffusion models spell badly; keep lettering out of firm artwork by default.
  const negative =
    String(input.negativePrompt ?? "").trim().slice(0, 1024) ||
    "text, letters, words, captions, watermark, signature, logo, blurry, low quality";
  const stability = IMAGE_MODEL.startsWith("stability.");
  const body = stability
    ? {
        prompt,
        aspect_ratio: STABILITY_RATIOS[ratio] ?? "1:1",
        output_format: "png",
        mode: "text-to-image",
        ...(negative ? { negative_prompt: negative } : {}),
      }
    : {
        taskType: "TEXT_IMAGE",
        textToImageParams: { text: prompt, ...(negative ? { negativeText: negative } : {}) },
        imageGenerationConfig: {
          numberOfImages: 1,
          quality: "standard",
          width: size.width,
          height: size.height,
          cfgScale: 6.5,
          seed: Math.floor(Math.random() * 858_993_459),
        },
      };
  const url = `https://bedrock-runtime.${IMAGE_REGION}.amazonaws.com/model/${encodeURIComponent(IMAGE_MODEL)}/invoke`;
  const res = await signedBedrockFetch(url, {
    body: JSON.stringify(body),
    headers: { accept: "application/json" },
    region: IMAGE_REGION,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OfficeToolError(
      res.status === 400 ? 422 : 502,
      `Image generation failed [${res.status}] (${IMAGE_MODEL} in ${IMAGE_REGION}): ${text.replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }
  let parsed: { images?: string[]; error?: string; finish_reasons?: Array<string | null> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new OfficeToolError(502, "Image generation returned an unreadable response.");
  }
  if (parsed.error) throw new OfficeToolError(422, `Image generation refused the prompt: ${parsed.error}`);
  const refused = parsed.finish_reasons?.find((r) => r && r !== "SUCCESS");
  if (refused) throw new OfficeToolError(422, `Image generation did not complete (${refused}); adjust the prompt.`);
  const base64 = parsed.images?.[0];
  if (!base64) throw new OfficeToolError(502, "Image generation returned no image.");
  const dims = imageDimensions(base64) ?? size;
  return { mime: "image/png", base64, width: dims.width, height: dims.height };
}

// --- Image editing (Stability Image Services on Bedrock) ------------------------------------------------

/**
 * Stability's edit/upscale/control models are enabled in this account in the
 * platform region. Each is its own model id with its own request shape; the
 * response shape matches text-to-image ({ images: [base64], finish_reasons }).
 */
const IMAGE_EDIT_REGION = process.env["OFFICE_IMAGE_EDIT_REGION"] || REGION;

export type ImageEditOperation =
  | "remove_background"
  | "search_replace"
  | "recolor"
  | "erase"
  | "inpaint"
  | "outpaint"
  | "style_guide"
  | "style_transfer"
  | "sketch"
  | "structure"
  | "upscale_fast"
  | "upscale_conservative"
  | "upscale_creative";

const IMAGE_EDIT_MODELS: Record<ImageEditOperation, string> = {
  remove_background: "stability.stable-image-remove-background-v1:0",
  search_replace: "stability.stable-image-search-replace-v1:0",
  recolor: "stability.stable-image-search-recolor-v1:0",
  erase: "stability.stable-image-erase-object-v1:0",
  inpaint: "stability.stable-image-inpaint-v1:0",
  outpaint: "stability.stable-outpaint-v1:0",
  style_guide: "stability.stable-image-style-guide-v1:0",
  style_transfer: "stability.stable-style-transfer-v1:0",
  sketch: "stability.stable-image-control-sketch-v1:0",
  structure: "stability.stable-image-control-structure-v1:0",
  upscale_fast: "stability.stable-fast-upscale-v1:0",
  upscale_conservative: "stability.stable-conservative-upscale-v1:0",
  upscale_creative: "stability.stable-creative-upscale-v1:0",
};

export const IMAGE_EDIT_OPERATIONS = Object.keys(IMAGE_EDIT_MODELS) as ImageEditOperation[];

export type ImageEditInput = {
  operation: ImageEditOperation;
  /** Source image bytes (PNG/JPEG/WebP base64, no data: prefix). */
  image: string;
  prompt?: string;
  /** search_replace / recolor: what to find in the image. */
  searchPrompt?: string;
  negativePrompt?: string;
  /** erase / inpaint: white = edit, black = keep. Optional for erase when the image has alpha. */
  mask?: string;
  /** style_transfer: the image whose look is applied to `image`. */
  styleImage?: string;
  /** outpaint: pixels to add per side (0..2000). */
  expand?: { left?: number; right?: number; up?: number; down?: number };
  /** sketch/structure control strength or style_guide fidelity, 0..1 */
  strength?: number;
  signal?: AbortSignal;
};

const MAX_EDIT_IMAGE_B64 = 14_000_000;

function clamp01(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function stabilityEditBody(input: ImageEditInput): Record<string, unknown> {
  const prompt = String(input.prompt ?? "").trim().slice(0, 1024);
  const negative = String(input.negativePrompt ?? "").trim().slice(0, 1024);
  const withNeg = negative ? { negative_prompt: negative } : {};
  const needPrompt = (): string => {
    if (!prompt) throw new OfficeToolError(422, `${input.operation} needs a prompt.`);
    return prompt;
  };
  switch (input.operation) {
    case "remove_background":
      return { image: input.image, output_format: "png" };
    case "search_replace":
      if (!input.searchPrompt) throw new OfficeToolError(422, "search_replace needs searchPrompt (what to find).");
      return { image: input.image, prompt: needPrompt(), search_prompt: input.searchPrompt.slice(0, 512), output_format: "png", ...withNeg };
    case "recolor":
      if (!input.searchPrompt) throw new OfficeToolError(422, "recolor needs searchPrompt (what to recolor).");
      return { image: input.image, prompt: needPrompt(), select_prompt: input.searchPrompt.slice(0, 512), output_format: "png", ...withNeg };
    case "erase":
      return { image: input.image, ...(input.mask ? { mask: input.mask } : {}), output_format: "png" };
    case "inpaint":
      return { image: input.image, prompt: needPrompt(), ...(input.mask ? { mask: input.mask } : {}), output_format: "png", ...withNeg };
    case "outpaint": {
      const side = (v: unknown) => Math.min(2000, Math.max(0, Math.round(Number(v) || 0)));
      const e = input.expand ?? {};
      const body: Record<string, unknown> = { image: input.image, output_format: "png", ...(prompt ? { prompt } : {}) };
      for (const k of ["left", "right", "up", "down"] as const) {
        const n = side(e[k]);
        if (n > 0) body[k] = n;
      }
      if (!["left", "right", "up", "down"].some((k) => k in body)) {
        throw new OfficeToolError(422, "outpaint needs at least one side in expand (left/right/up/down pixels).");
      }
      return body;
    }
    case "style_guide":
      return { image: input.image, prompt: needPrompt(), fidelity: clamp01(input.strength, 0.5), output_format: "png", ...withNeg };
    case "style_transfer":
      if (!input.styleImage) throw new OfficeToolError(422, "style_transfer needs styleImage.");
      return { init_image: input.image, style_image: input.styleImage, ...(prompt ? { prompt } : {}), output_format: "png", ...withNeg };
    case "sketch":
    case "structure":
      return { image: input.image, prompt: needPrompt(), control_strength: clamp01(input.strength, 0.7), output_format: "png", ...withNeg };
    case "upscale_fast":
      return { image: input.image, output_format: "png" };
    case "upscale_conservative":
    case "upscale_creative":
      return { image: input.image, prompt: needPrompt(), output_format: "png", ...withNeg };
    default:
      throw new OfficeToolError(422, `Unknown image operation "${String(input.operation)}".`);
  }
}

/** Edit, extend, restyle or upscale an image with the Stability suite on Bedrock. */
export async function editOfficeImage(input: ImageEditInput): Promise<ToolImage & { width: number; height: number }> {
  if (!imageGenerationEnabled()) throw new OfficeToolError(501, "Image generation is disabled.");
  const model = IMAGE_EDIT_MODELS[input.operation];
  if (!model) throw new OfficeToolError(422, `Unknown image operation "${String(input.operation)}".`);
  if (typeof input.image !== "string" || input.image.length < 64) throw new OfficeToolError(422, "image (base64) is required.");
  if (input.image.length > MAX_EDIT_IMAGE_B64) throw new OfficeToolError(413, "The source image is too large.");
  const body = stabilityEditBody(input);
  const url = `https://bedrock-runtime.${IMAGE_EDIT_REGION}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
  const res = await signedBedrockFetch(url, {
    body: JSON.stringify(body),
    headers: { accept: "application/json" },
    region: IMAGE_EDIT_REGION,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OfficeToolError(
      res.status === 400 ? 422 : 502,
      `Image edit failed [${res.status}] (${model} in ${IMAGE_EDIT_REGION}): ${text.replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }
  let parsed: { images?: string[]; error?: string; finish_reasons?: Array<string | null> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new OfficeToolError(502, "Image edit returned an unreadable response.");
  }
  if (parsed.error) throw new OfficeToolError(422, `Image edit refused the request: ${parsed.error}`);
  const refused = parsed.finish_reasons?.find((r) => r && r !== "SUCCESS");
  if (refused) throw new OfficeToolError(422, `Image edit did not complete (${refused}); adjust the prompt.`);
  const base64 = parsed.images?.[0];
  if (!base64) throw new OfficeToolError(502, "Image edit returned no image.");
  const dims = imageDimensions(base64) ?? { width: 0, height: 0 };
  return { mime: "image/png", base64, width: dims.width, height: dims.height };
}

// --- Image download (for insert-by-URL in every editor) ---------------------------------------------------

const MAX_FETCHED_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_MIMES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

function sniffMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * Download a public image for insertion (the browser cannot: CORS). Same SSRF
 * guard as fetch_page (blocked hosts/ranges, DNS check, no redirects to
 * private space), bounded size, image content only.
 */
export async function fetchOfficeImage(
  url: string,
  signal?: AbortSignal,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; bytes: number }> {
  const { validateFetchTarget } = await import("@/lib/agents/fetch-page.server");
  let target: URL;
  try {
    target = await validateFetchTarget(String(url ?? ""), undefined, signal);
  } catch (e) {
    throw new OfficeToolError(422, e instanceof Error ? e.message : "Invalid image URL.");
  }
  let current = target;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current.toString(), {
      redirect: "manual",
      headers: { accept: "image/*,*/*;q=0.5", "user-agent": "SeegerWeissLitAI/1.0 (+image-fetch)" },
      ...(signal ? { signal } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new OfficeToolError(502, "The image server redirected without a target.");
      try {
        current = await validateFetchTarget(new URL(loc, current), undefined, signal);
      } catch (e) {
        throw new OfficeToolError(422, e instanceof Error ? e.message : "Blocked redirect.");
      }
      continue;
    }
    if (!res.ok) throw new OfficeToolError(502, `The image could not be downloaded [${res.status}].`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_FETCHED_IMAGE_BYTES) throw new OfficeToolError(413, "The image is larger than 12 MB.");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_FETCHED_IMAGE_BYTES) throw new OfficeToolError(413, "The image is larger than 12 MB.");
    const header = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const mime = sniffMime(buf) ?? IMAGE_MIMES[header] ?? null;
    if (!mime) throw new OfficeToolError(422, "The URL did not return a PNG, JPEG, GIF or WebP image.");
    return { base64: Buffer.from(buf).toString("base64"), mime, bytes: buf.length };
  }
  throw new OfficeToolError(502, "Too many redirects while downloading the image.");
}

// --- Firm knowledge (KB workspaces) and Library ---------------------------------------------------------------

export type FirmKnowledgeHit = {
  workspace: string;
  workspaceId: string;
  document: string;
  docId: string;
  pages: string;
  score: number;
  snippet: string;
};

/**
 * Search the user's knowledge-base workspaces (uploaded, OCR'd document sets:
 * working sets, deposition sets, review sets). Hybrid pgvector + BM25 search
 * with rerank per workspace; the newest ready workspaces are searched when no
 * workspace is named. Access is scoped by the caller's principal throughout.
 */
export async function searchFirmKnowledge(
  principal: string,
  input: { query: string; workspace?: string; topK?: number; signal?: AbortSignal },
): Promise<{ hits: FirmKnowledgeHit[]; searched: string[]; available: string[] }> {
  const query = String(input.query ?? "").trim();
  if (!query) throw new OfficeToolError(422, "query is required.");
  const { listWorkspaces, getWorkspace } = await import("@/lib/kb/workspace.server");
  const { searchKb } = await import("@/lib/kb/search.server");
  const all = (await listWorkspaces(principal)).filter((w) => w.status === "ready" && w.docCount > 0);
  const wanted = String(input.workspace ?? "").trim().toLowerCase();
  const chosen = wanted
    ? all.filter((w) => w.itemId === input.workspace || w.name.toLowerCase().includes(wanted))
    : all.slice(0, 6);
  const topK = Math.min(Math.max(1, input.topK ?? 10), 30);
  const hits: FirmKnowledgeHit[] = [];
  await Promise.all(
    chosen.map(async (w) => {
      const detail = await getWorkspace(principal, w.itemId).catch(() => null);
      if (!detail?.kbWorkspaceId) return;
      const names = new Map(detail.docs.map((d) => [d.docId, d.fileName]));
      const found = await searchKb(principal, {
        workspaceId: detail.kbWorkspaceId,
        surface: w.surface,
        query,
        topK,
        ...(input.signal ? { signal: input.signal } : {}),
      }).catch(() => []);
      for (const h of found) {
        hits.push({
          workspace: w.name,
          workspaceId: w.itemId,
          document: names.get(h.doc_id) ?? h.doc_id,
          docId: h.doc_id,
          pages:
            h.page_start && h.page_end && h.page_end !== h.page_start
              ? `${h.page_start}-${h.page_end}`
              : String(h.page_start ?? "?"),
          score: h.score,
          snippet: h.content.replace(/\s+/g, " ").trim().slice(0, 1200),
        });
      }
    }),
  );
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, topK), searched: chosen.map((w) => w.name), available: all.map((w) => w.name) };
}

export type LibraryHit = OfficeDocSummary & { url: string };

/** Route that opens a Library document in its editor. */
export function officeDocUrl(doc: Pick<OfficeDocSummary, "kind" | "draftId">): string {
  return doc.kind === "pptx"
    ? `/office/slides/${doc.draftId}`
    : doc.kind === "xlsx"
      ? `/office/sheets/${doc.draftId}`
      : `/office/drafts/${doc.draftId}`;
}

/** Find documents in the user's Library by name (all kinds or one kind). */
export async function searchLibrary(
  principal: string,
  input: { query?: string; kind?: string; limit?: number },
): Promise<LibraryHit[]> {
  const { listOfficeDocs } = await import("./office.server");
  const kind = input.kind === "docx" || input.kind === "xlsx" || input.kind === "pptx" ? input.kind : undefined;
  const docs = await listOfficeDocs(principal, kind);
  const terms = String(input.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const scored = docs
    .map((d) => {
      const name = d.name.toLowerCase();
      const score = terms.length ? terms.reduce((n, t) => n + (name.includes(t) ? 1 : 0), 0) : 1;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.d.updatedAt < b.d.updatedAt ? 1 : -1))
    .slice(0, Math.min(Math.max(1, input.limit ?? 20), 50));
  return scored.map(({ d }) => ({ ...d, url: officeDocUrl(d) }));
}

// --- Citations ------------------------------------------------------------------------------------------

export async function verifyOfficeCitations(text: string): Promise<string> {
  if (!courtlistenerConfigured()) return "Citation lookup is not configured on this platform (COURTLISTENER_API_TOKEN).";
  const value = String(text ?? "").trim();
  if (value.length < 3) return "Provide text containing at least one reporter citation.";
  const results = await lookupCitations(value.slice(0, 64_000));
  if (!results.length) return "No recognizable legal citations were found in that text.";
  const lines = results.map((r) => {
    if (r.found) return `CONFIRMED  ${r.citation} -> ${r.caseName || "(opinion)"}${r.url ? `  ${r.url}` : ""}`;
    if (r.ambiguous) return `AMBIGUOUS  ${r.citation} (multiple matches; add a pin cite, year or court to narrow it)`;
    return `NOT FOUND  ${r.citation} (status ${r.status}; do not rely on this cite without confirming it elsewhere)`;
  });
  const confirmed = results.filter((r) => r.found).length;
  return `Citation check: ${confirmed}/${results.length} confirmed against CourtListener.\n${lines.join("\n")}`;
}

// --- Web page -------------------------------------------------------------------------------------------

export async function readOfficePage(url: string, maxChars = 12_000): Promise<string> {
  const page = await fetchPage(String(url ?? ""), { maxChars: Math.min(Math.max(1000, maxChars), 60_000), timeoutMs: 25_000 });
  const head = [`Title: ${page.title || "(untitled)"}`, `URL: ${page.finalUrl || page.url}`];
  if (page.note) head.push(`Note: ${page.note}`);
  if (page.truncated) head.push("Note: the page was longer than the limit; this is the beginning.");
  return `${head.join("\n")}\n\n${page.text}`;
}

// --- Cross-app documents -----------------------------------------------------------------------------------

export type CreatedOfficeDocument =
  | { kind: "docx" | "xlsx" | "pptx"; doc: OfficeDocSummary; url: string }
  | { kind: "pdf"; name: string; base64: string; size: number };

const MAX_MARKDOWN = 200_000;

type OutlineSlide = { title: string; bullets: string[] };

/** Markdown outline -> slides: `#`/`##` headings start slides, list items become bullets. */
export function outlineFromMarkdown(markdown: string, fallbackTitle: string): OutlineSlide[] {
  const slides: OutlineSlide[] = [];
  let current: OutlineSlide | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      current = { title: heading[1]!.trim(), bullets: [] };
      slides.push(current);
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) {
        current = { title: fallbackTitle, bullets: [] };
        slides.push(current);
      }
      current.bullets.push(bullet[1]!.trim());
      continue;
    }
    if (line.trim() && current) current.bullets.push(line.trim());
  }
  if (!slides.length) slides.push({ title: fallbackTitle, bullets: markdown.trim() ? [markdown.trim().slice(0, 400)] : [] });
  return slides.slice(0, 60).map((s) => ({ title: s.title.slice(0, 200), bullets: s.bullets.slice(0, 12).map((b) => b.slice(0, 400)) }));
}

/** Build an editable deck: one 16:9 slide per outline entry, title box + bullet body. */
async function buildDeck(title: string, markdown: string): Promise<Uint8Array> {
  const { createBlankPptx, openPptx, savePptx, insertBlankSlide, addElement, deleteSlide } = await import(
    "@genoffice/pptx-engine"
  );
  const opened = await openPptx(await createBlankPptx());
  const size = opened.deck.size;
  const margin = Math.round(size.cx * 0.06);
  const titleH = Math.round(size.cy * 0.18);
  const outline = outlineFromMarkdown(markdown, title);
  // Cover slide first, then one slide per entry; remove the template's blank slide at the end.
  const entries: OutlineSlide[] = [{ title, bullets: [] }, ...outline];
  for (let i = 0; i < entries.length; i++) {
    const slide = insertBlankSlide(opened, opened.deck.slides.length - 1);
    if (!slide) throw new OfficeToolError(500, "Could not add a slide.");
    const entry = entries[i]!;
    const isCover = i === 0;
    addElement(slide, {
      kind: "textbox",
      offset: isCover
        ? { x: margin, y: Math.round(size.cy * 0.36), cx: size.cx - 2 * margin, cy: titleH }
        : { x: margin, y: margin, cx: size.cx - 2 * margin, cy: titleH },
      paragraphs: [
        {
          runs: [{ text: entry.title, bold: true, fontSize: isCover ? 40 : 30 }],
          ...(isCover ? { align: "center" as const } : {}),
        },
      ],
      bodyPr: { anchor: "ctr" },
    });
    if (entry.bullets.length) {
      addElement(slide, {
        kind: "textbox",
        offset: {
          x: margin,
          y: margin + titleH + Math.round(size.cy * 0.04),
          cx: size.cx - 2 * margin,
          cy: size.cy - (margin + titleH + Math.round(size.cy * 0.04)) - margin,
        },
        paragraphs: entry.bullets.map((b) => ({
          runs: [{ text: b, fontSize: entry.bullets.length > 7 ? 16 : 20 }],
          bullet: { type: "char" as const, char: "•" },
          marL: 342_900,
          indent: -342_900,
          spaceAfter: 6,
        })),
      });
    }
    slide.structureDirty = true;
  }
  deleteSlide(opened, 0);
  return savePptx(opened);
}

/**
 * The Writer's and Sheets' own create_document tools hand over simple HTML
 * (h1-h6, p, ul/ol/li, table, pre, blockquote, inline strong/em/u/s). Convert
 * that subset to the Markdown docgen consumes; unknown tags are dropped, text
 * is kept.
 */
export function htmlToMarkdown(html: string): string {
  const decode = (s: string) =>
    s
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const inline = (s: string) =>
    decode(
      s
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
        .replace(/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, "~~$2~~")
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
        .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
        .replace(/<[^>]+>/g, ""),
    )
      .replace(/[ \t]+/g, " ")
      .trim();
  const out: string[] = [];
  const blocks = html.match(/<(h[1-6]|p|ul|ol|table|pre|blockquote)\b[^>]*>[\s\S]*?<\/\1>|[^<]+/gi) ?? [];
  for (const block of blocks) {
    const tag = /^<(\w+)/.exec(block)?.[1]?.toLowerCase();
    if (!tag) {
      const text = inline(block);
      if (text) out.push(text);
      continue;
    }
    const body = block.replace(/^<[^>]+>/, "").replace(/<\/\w+>$/, "");
    if (/^h[1-6]$/.test(tag)) out.push(`${"#".repeat(Number(tag[1]))} ${inline(body)}`);
    else if (tag === "p") out.push(inline(body));
    else if (tag === "pre") out.push("```\n" + decode(body.replace(/<[^>]+>/g, "")) + "\n```");
    else if (tag === "blockquote") out.push(inline(body).split("\n").map((l) => `> ${l}`).join("\n"));
    else if (tag === "ul" || tag === "ol") {
      const items = body.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) ?? [];
      out.push(items.map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${inline(li)}`).join("\n"));
    } else if (tag === "table") {
      const rows = (body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []).map((tr) =>
        (tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map((c) => inline(c).replace(/\|/g, "\\|")),
      );
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
        const lines = [`| ${pad(rows[0]!).join(" | ")} |`, `|${" --- |".repeat(width)}`];
        for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
        out.push(lines.join("\n"));
      }
    }
  }
  return out.filter(Boolean).join("\n\n");
}

/**
 * Create a Library document from markdown. DOCX/XLSX/PDF render through the
 * Research agent's docgen (python-docx / openpyxl / reportlab, legal style);
 * PPTX is assembled with pptx-engine so every slide stays editable in Slides.
 */
export async function createOfficeDocumentFromMarkdown(
  principal: string,
  input: { kind: string; title: string; markdown: string; style?: string; format?: "markdown" | "html" },
): Promise<CreatedOfficeDocument> {
  const kind = String(input.kind ?? "docx") as "docx" | "xlsx" | "pptx" | "pdf";
  if (!["docx", "xlsx", "pptx", "pdf"].includes(kind)) throw new OfficeToolError(422, "kind must be docx, xlsx, pptx or pdf.");
  const title = String(input.title ?? "").trim().slice(0, 160);
  if (!title) throw new OfficeToolError(422, "title is required.");
  const raw = String(input.markdown ?? "");
  if (!raw.trim()) throw new OfficeToolError(422, "content is required.");
  if (raw.length > MAX_MARKDOWN) throw new OfficeToolError(413, "content is too long.");
  const markdown = input.format === "html" ? htmlToMarkdown(raw) : raw;
  if (!markdown.trim()) throw new OfficeToolError(422, "content did not contain any text.");

  if (kind === "pptx") {
    const bytes = await buildDeck(title, markdown);
    const doc = await createOfficeDoc(principal, { kind: "pptx", name: `${title}.pptx`, bytes });
    return { kind, doc, url: `/office/slides/${doc.draftId}` };
  }
  const generated = await generateDocument(kind, title, markdown, title, input.style ?? "legal");
  if ("error" in generated) throw new OfficeToolError(502, `Document generation failed: ${generated.error}`);
  const bytes = new Uint8Array(Buffer.from(generated.dataB64, "base64"));
  if (kind === "pdf") return { kind, name: generated.name, base64: generated.dataB64, size: generated.size };
  const doc = await createOfficeDoc(principal, { kind, name: generated.name, bytes });
  return { kind, doc, url: kind === "docx" ? `/office/drafts/${doc.draftId}` : `/office/sheets/${doc.draftId}` };
}
