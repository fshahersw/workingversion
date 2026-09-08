// Word import, in the browser: DOCX -> HTML (mammoth) -> editor JSON
// (TipTap's headless generateJSON with the same extensions the editor uses).
// The result is saved as the draft's content before the editor page opens, so
// the import never depends on editor mount timing. Falls back to the file's
// raw text as paragraphs when the HTML conversion yields no readable text.
import { generateJSON } from "@tiptap/core";

import { docToText, paragraphsDoc } from "./doc-text";
import { draftExtensions } from "./editor-extensions";
import type { DraftContent, JsonValue } from "./types";

export type ImportResult = {
  /** Null when no text could be read from the file. */
  content: DraftContent | null;
  /** mammoth conversion warnings (unsupported styles and the like), for logging. */
  warnings: string[];
  /** "html" when the formatted conversion was used, "text" for the raw-text fallback. */
  via: "html" | "text" | "none";
};

/** Drop what the editor cannot keep faithfully (embedded images, scripts). */
export function sanitizeImportHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "");
}

export async function convertDocxToContent(buf: ArrayBuffer): Promise<ImportResult> {
  const mammoth = await import("mammoth/mammoth.browser");
  const warnings: string[] = [];
  let doc: JsonValue | null = null;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    for (const m of result.messages ?? []) if (m?.message) warnings.push(String(m.message));
    const html = sanitizeImportHtml(result.value ?? "");
    if (html.trim()) {
      const json = generateJSON(html, draftExtensions("")) as JsonValue;
      if (docToText(json).trim()) doc = json;
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : "HTML conversion failed");
  }
  if (doc) {
    return { content: { format: "tiptap", doc, text: docToText(doc) }, warnings, via: "html" };
  }
  try {
    const raw = await mammoth.extractRawText({ arrayBuffer: buf });
    const text = (raw.value ?? "").trim();
    if (text) {
      const fallback = paragraphsDoc(text);
      return {
        content: { format: "tiptap", doc: fallback, text: docToText(fallback) },
        warnings,
        via: "text",
      };
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : "text extraction failed");
  }
  return { content: null, warnings, via: "none" };
}
