// Client-callable server functions behind the Office assistants' platform
// tools (see src/office/shared/platform-skill.ts). All gated by requireAuth;
// inputs are bounded here before reaching the heavier server modules.
import { createServerFn } from "@tanstack/react-start";

import type { SwUser } from "@/lib/auth/cognito.server";
import { requireAuth } from "@/lib/auth/require-auth";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== "string") throw new Error(`${field} required`);
  if (v.length > max) throw new Error(`${field} too long`);
  return v;
};

export const officeRunPythonFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { code: string }) => ({ code: str(d?.code, 40_000, "code") }))
  .handler(async ({ data }) => {
    const { runOfficePython } = await import("./tools.server");
    return runOfficePython(data.code);
  });

export const officeRenderGraphvizFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { source: string; engine?: string }) => ({
    source: str(d?.source, 60_000, "source"),
    engine: typeof d?.engine === "string" ? d.engine.slice(0, 16) : "dot",
  }))
  .handler(async ({ data }) => {
    const { renderGraphviz } = await import("./tools.server");
    return renderGraphviz(data.source, data.engine);
  });

export const officeGenerateImageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { prompt: string; aspectRatio?: string; negativePrompt?: string }) => ({
    prompt: str(d?.prompt, 1024, "prompt"),
    ...(typeof d?.aspectRatio === "string" ? { aspectRatio: d.aspectRatio.slice(0, 8) } : {}),
    ...(typeof d?.negativePrompt === "string" ? { negativePrompt: d.negativePrompt.slice(0, 1024) } : {}),
  }))
  .handler(async ({ data }) => {
    const { generateOfficeImage } = await import("./tools.server");
    return generateOfficeImage(data);
  });

const IMAGE_OPS = new Set([
  "remove_background",
  "search_replace",
  "recolor",
  "erase",
  "inpaint",
  "outpaint",
  "style_guide",
  "style_transfer",
  "sketch",
  "structure",
  "upscale_fast",
  "upscale_conservative",
  "upscale_creative",
]);

const optStr = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length ? v.slice(0, max) : undefined;

export const officeEditImageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: {
      operation: string;
      image: string;
      prompt?: string;
      searchPrompt?: string;
      negativePrompt?: string;
      mask?: string;
      styleImage?: string;
      expand?: { left?: number; right?: number; up?: number; down?: number };
      strength?: number;
    }) => {
      if (!IMAGE_OPS.has(String(d?.operation))) throw new Error("operation is not a supported image edit");
      return {
        operation: d.operation as import("./tools.server").ImageEditOperation,
        image: str(d?.image, 14_000_000, "image"),
        ...(optStr(d?.prompt, 1024) ? { prompt: optStr(d?.prompt, 1024) } : {}),
        ...(optStr(d?.searchPrompt, 512) ? { searchPrompt: optStr(d?.searchPrompt, 512) } : {}),
        ...(optStr(d?.negativePrompt, 1024) ? { negativePrompt: optStr(d?.negativePrompt, 1024) } : {}),
        ...(optStr(d?.mask, 14_000_000) ? { mask: optStr(d?.mask, 14_000_000) } : {}),
        ...(optStr(d?.styleImage, 14_000_000) ? { styleImage: optStr(d?.styleImage, 14_000_000) } : {}),
        ...(d?.expand && typeof d.expand === "object" ? { expand: d.expand } : {}),
        ...(Number.isFinite(d?.strength) ? { strength: Number(d.strength) } : {}),
      };
    },
  )
  .handler(async ({ data }) => {
    const { editOfficeImage } = await import("./tools.server");
    return editOfficeImage(data);
  });

export const officeFetchImageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { url: string }) => ({ url: str(d?.url, 4096, "url") }))
  .handler(async ({ data }) => {
    const { fetchOfficeImage } = await import("./tools.server");
    return fetchOfficeImage(data.url);
  });

/** Web image search for the editors' image_search tools (Tavily images; empty when not configured). */
export const officeImageSearchFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { query: string; maxResults?: number }) => ({
    query: str(d?.query, 400, "query"),
    maxResults: Number.isFinite(d?.maxResults) ? Math.max(1, Math.min(20, Number(d.maxResults))) : 8,
  }))
  .handler(async ({ data }) => {
    const { tavilyConfigured, tavilyImageSearch } = await import("@/lib/agents/tavily-search.server");
    if (!tavilyConfigured()) {
      return { images: [] as Array<{ imageUrl: string; title: string }>, method: "error" as const, error: "Image search is not configured on this platform (TAVILY_API_KEY)." };
    }
    const images = await tavilyImageSearch(data.query, data.maxResults);
    return { images, method: "tavily" as const };
  });

export const officeSearchKnowledgeFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { query: string; workspace?: string; topK?: number }) => ({
    query: str(d?.query, 2000, "query"),
    ...(optStr(d?.workspace, 200) ? { workspace: optStr(d?.workspace, 200) } : {}),
    ...(Number.isFinite(d?.topK) ? { topK: Number(d.topK) } : {}),
  }))
  .handler(async ({ context, data }) => {
    const { searchFirmKnowledge } = await import("./tools.server");
    return searchFirmKnowledge(principalOf(context), data);
  });

export const officeSearchLibraryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d?: { query?: string; kind?: string; limit?: number }) => ({
    ...(optStr(d?.query, 300) ? { query: optStr(d?.query, 300) } : {}),
    ...(optStr(d?.kind, 8) ? { kind: optStr(d?.kind, 8) } : {}),
    ...(Number.isFinite(d?.limit) ? { limit: Number(d?.limit) } : {}),
  }))
  .handler(async ({ context, data }) => {
    const { searchLibrary } = await import("./tools.server");
    return { docs: await searchLibrary(principalOf(context), data) };
  });

export const officeListTemplatesFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d?: { kind?: string }) => ({ kind: str(d?.kind ?? "docx", 8, "kind") }))
  .handler(async ({ context, data }) => {
    const { listTemplates } = await import("./templates.server");
    return { templates: await listTemplates(principalOf(context), data.kind) };
  });

export const officeGetTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { kind: string; id: string }) => ({
    kind: str(d?.kind, 8, "kind"),
    id: str(d?.id, 120, "id"),
  }))
  .handler(async ({ context, data }) => {
    const { getTemplate } = await import("./templates.server");
    return getTemplate(principalOf(context), data.kind, data.id);
  });

export const officeSaveTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { kind: string; name: string; description?: string; category?: string; payload: unknown }) => ({
    kind: str(d?.kind, 8, "kind"),
    name: str(d?.name, 120, "name"),
    ...(optStr(d?.description, 400) ? { description: optStr(d?.description, 400) } : {}),
    ...(optStr(d?.category, 60) ? { category: optStr(d?.category, 60) } : {}),
    payload: d?.payload,
  }))
  .handler(async ({ context, data }) => {
    const { saveTemplate } = await import("./templates.server");
    return saveTemplate(principalOf(context), data);
  });

/** Attachment extraction (PDF/TIFF OCR through BDA; DOCX/PPTX/XLSX through the sandbox). */
export const officeExtractAttachmentFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { name: string; b64: string; mime?: string }) => ({
    name: str(d?.name, 200, "name"),
    b64: str(d?.b64, 36_000_000, "file"),
    ...(optStr(d?.mime, 100) ? { mime: optStr(d?.mime, 100) } : {}),
  }))
  .handler(async ({ data }) => {
    const { startAttachmentExtract } = await import("./attachments.server");
    return startAttachmentExtract(data);
  });

export const officePollAttachmentFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { invocationArn: string; cacheKey: string; name: string; kind: "pdf" | "image" }) => ({
    invocationArn: str(d?.invocationArn, 512, "invocationArn"),
    cacheKey: str(d?.cacheKey, 200, "cacheKey"),
    name: str(d?.name, 200, "name"),
    kind: d?.kind === "image" ? ("image" as const) : ("pdf" as const),
  }))
  .handler(async ({ data }) => {
    const { pollAttachmentExtract } = await import("./attachments.server");
    return pollAttachmentExtract(data);
  });

export const officeVerifyCitationsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { text: string }) => ({ text: str(d?.text, 64_000, "text") }))
  .handler(async ({ data }) => {
    const { verifyOfficeCitations } = await import("./tools.server");
    return { text: await verifyOfficeCitations(data.text) };
  });

export const officeFetchPageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { url: string; maxChars?: number }) => ({
    url: str(d?.url, 2048, "url"),
    maxChars: Number.isFinite(d?.maxChars) ? Number(d.maxChars) : 12_000,
  }))
  .handler(async ({ data }) => {
    const { readOfficePage } = await import("./tools.server");
    return { text: await readOfficePage(data.url, data.maxChars) };
  });

export const officeCreateDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { kind: string; title: string; markdown: string; style?: string; format?: "markdown" | "html" }) => ({
      kind: str(d?.kind, 8, "kind"),
      title: str(d?.title, 200, "title"),
      markdown: str(d?.markdown, 200_000, "content"),
      ...(typeof d?.style === "string" ? { style: d.style.slice(0, 16) } : {}),
      format: d?.format === "html" ? ("html" as const) : ("markdown" as const),
    }),
  )
  .handler(async ({ context, data }) => {
    const { createOfficeDocumentFromMarkdown } = await import("./tools.server");
    return createOfficeDocumentFromMarkdown(principalOf(context), data);
  });

export const officeGuideFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d?: { name?: string }) => ({
    name: typeof d?.name === "string" ? d.name.slice(0, 64) : "",
  }))
  .handler(async ({ data }) => {
    const { getFirmGuide, listFirmGuides } = await import("./guides");
    if (!data.name) return { guides: listFirmGuides() };
    const guide = getFirmGuide(data.name);
    if (!guide) return { error: `Unknown guide "${data.name}".`, guides: listFirmGuides() };
    return { guide };
  });
