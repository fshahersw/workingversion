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

export async function readOfficePage(url: string, maxChars = 8000): Promise<string> {
  const page = await fetchPage(String(url ?? ""), { maxChars: Math.min(Math.max(1000, maxChars), 20_000), timeoutMs: 20_000 });
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
