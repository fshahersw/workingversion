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
    maxChars: Number.isFinite(d?.maxChars) ? Number(d.maxChars) : 8000,
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
