// Upload a file into the code-interpreter sandbox so run_python can read it by
// name during this session. Text and binary both arrive base64-encoded and are
// written via writeFileB64 (relative path). Single-process dev: the sandbox
// session is a module singleton, so a file uploaded here is visible to a later
// /api/orchestrate run_python in the same process. Names are sanitized to a
// bare basename to keep everything in the sandbox working dir.
import { createFileRoute } from "@tanstack/react-router";
import { writeFileB64, extractDocument } from "@/lib/agents/code-interpreter.server";

const MAX_B64_LEN = 8 * 1024 * 1024; // ~6MB decoded ceiling for inline upload
// Full extracted text up to this size is injected directly into the model
// context; larger docs inject only a preview+outline and keep the full text in
// the sandbox for on-demand read_document retrieval.
const INJECT_BUDGET = 8000;
const PREVIEW_CHARS = 2600;

function outline(kind: string, meta: Record<string, unknown>): string {
  if (kind === "pdf" && meta.pages) return `PDF, ${meta.pages} pages.`;
  if (kind === "table" && meta.sheets) {
    const sheets = (meta.sheets as { sheet: string; rows: number; cols: number }[]) || [];
    return `Spreadsheet — sheets: ${sheets.map((s) => `${s.sheet} (${s.rows}x${s.cols})`).join(", ")}.`;
  }
  if (kind === "table" && meta.columns)
    return `Table, ${meta.rows}x${meta.cols}, columns: ${(meta.columns as string[]).join(", ")}.`;
  if (kind === "docx") {
    const heads = (meta.headings as string[]) || [];
    return `Word document, ${meta.paragraphs ?? "?"} paragraphs${heads.length ? `; headings: ${heads.slice(0, 20).join(" · ")}` : ""}.`;
  }
  if (kind === "pptx" && meta.slides) return `Presentation, ${meta.slides} slides.`;
  if (kind === "image") return `Image ${meta.width}x${meta.height} (${meta.format}); no text — vision not enabled.`;
  return "";
}

/** basename + strip anything but word chars, dot, dash; never leading dot/slash. */
function safeName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").trim();
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "upload.bin";
}

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { name?: string; b64?: string; mime?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
        }
        const name = safeName(body.name ?? "");
        const b64 = (body.b64 ?? "").replace(/^data:[^;]*;base64,/, "");
        if (!b64) return Response.json({ ok: false, error: "empty file" }, { status: 400 });
        if (b64.length > MAX_B64_LEN)
          return Response.json({ ok: false, error: "file too large (max ~6MB)" }, { status: 413 });
        try {
          await writeFileB64(name, b64);
          const size = Math.floor((b64.length * 3) / 4);
          const doc = await extractDocument(name);
          const head = outline(doc.kind, doc.meta);
          const injectFull = doc.chars > 0 && doc.chars <= INJECT_BUDGET;
          const contextText = injectFull
            ? doc.text
            : `${head}\n\nPREVIEW (first ${PREVIEW_CHARS} chars — full text available via read_document("${name}", query)):\n${doc.text.slice(0, PREVIEW_CHARS)}`;
          return Response.json({
            ok: true,
            name,
            kind: doc.kind,
            size,
            meta: doc.meta,
            contextText,
            hasFullText: !injectFull && doc.chars > 0,
            chars: doc.chars,
            ...(doc.error ? { extractError: doc.error } : {}),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : "upload failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
