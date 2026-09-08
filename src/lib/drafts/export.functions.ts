// Export a draft as DOCX or PDF. The client sends the document as markdown
// (the editor's own serialization) and the server renders it with the same
// docgen pipeline the research agent uses for file deliverables, so exports
// match the chat's report styling. Returns the file as base64 for download.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import { isDraftStyle, type DraftStyle } from "./types";

const MAX_EXPORT_CHARS = 600_000;

export type DraftExportResult =
  | { ok: true; name: string; mime: string; dataB64: string; size: number }
  | { ok: false; error: string };

export const exportDraftFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { format: "docx" | "pdf"; title: string; markdown: string; style?: DraftStyle }) => {
      if (d?.format !== "docx" && d?.format !== "pdf")
        throw new Error("format must be docx or pdf");
      if (typeof d.markdown !== "string" || !d.markdown.trim())
        throw new Error("document is empty");
      if (d.markdown.length > MAX_EXPORT_CHARS) throw new Error("document is too long to export");
      return {
        format: d.format,
        title:
          typeof d.title === "string" && d.title.trim() ? d.title.trim().slice(0, 160) : "Document",
        markdown: d.markdown,
        style: isDraftStyle(d.style) ? d.style : ("legal" as DraftStyle),
      };
    },
  )
  .handler(async ({ data }): Promise<DraftExportResult> => {
    const { generateDocument } = await import("@/lib/agents/docgen.server");
    const out = await generateDocument(
      data.format,
      data.title,
      data.markdown,
      data.title,
      data.style,
    );
    if ("error" in out) return { ok: false, error: out.error };
    return { ok: true, name: out.name, mime: out.mime, dataB64: out.dataB64, size: out.size };
  });
