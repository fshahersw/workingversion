// ============================================================================
// Upload ingestion orchestration (server-only).
//
// Two paths, chosen by file type:
//  - BDA (pdf + images): Amazon Bedrock Data Automation OCRs + summarizes +
//    returns whole-document markdown. Async -> the caller polls. Full markdown
//    is stored in S3 for on-demand read_document retrieval; the AI summary +
//    an outline are injected so the model understands the whole file.
//  - Sandbox (csv/xlsx/docx/pptx/txt/md/html/json/…): the code interpreter
//    extracts text natively AND keeps the raw file so run_python can compute
//    over it. Instant.
//
// In both cases the model never gets a blindly-truncated blob: small docs are
// injected in full; large docs get summary+outline+preview and the rest is
// retrievable via read_document.
// ============================================================================
import type { Attachment } from "@/lib/chat-types";
import { writeFileB64, extractDocument } from "./code-interpreter.server";
import { putObject, startExtraction, getStatus, readResult, putText } from "./bda.server";

const INJECT_BUDGET = 8000; // full text up to this many chars is injected directly
const PREVIEW_CHARS = 2600; // otherwise inject summary+outline + this much preview
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB decoded ceiling

const BDA_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp"]);

export function extOf(name: string): string {
  return name.includes(".") ? (name.split(".").pop() as string).toLowerCase() : "";
}

/** basename + strip anything but word/dot/dash; never leading dot. */
export function sanitizeName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").trim();
  return (base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 120)) || "upload.bin";
}

function routeFor(ext: string): "bda" | "sandbox" {
  return BDA_EXTS.has(ext) ? "bda" : "sandbox";
}

function outline(kind: string, meta: Record<string, unknown>): string {
  if (kind === "pdf" && meta.pages) return `PDF · ${meta.pages} page(s)`;
  if (kind === "image") return `Image (OCR'd)`;
  if (kind === "table" && Array.isArray(meta.columns)) return `Table · columns: ${(meta.columns as string[]).slice(0, 40).join(", ")}`;
  if (kind === "table" && Array.isArray(meta.sheets)) return `Spreadsheet · ${(meta.sheets as unknown[]).length} sheet(s)`;
  if (kind === "docx") return `Word document`;
  if (kind === "pptx") return `Presentation · ${meta.slides ?? "?"} slide(s)`;
  return "";
}

/** Assemble the model-facing contextText: summary + outline, then either the
 *  full body (small) or a preview with a read_document pointer (large). */
function buildContext(summary: string, body: string, outlineStr: string): { contextText: string; hasFullText: boolean } {
  const header = [summary.trim(), outlineStr].filter(Boolean).join("\n");
  if (body.length <= INJECT_BUDGET) {
    return { contextText: `${header ? header + "\n\n" : ""}${body}`.trim(), hasFullText: false };
  }
  return {
    contextText: `${header ? header + "\n\n" : ""}PREVIEW (first ${PREVIEW_CHARS} chars; the full document is searchable — call read_document with keywords for the rest):\n${body.slice(0, PREVIEW_CHARS)}`.trim(),
    hasFullText: true,
  };
}

export type StartResult =
  | { status: "ready"; attachment: Attachment }
  | { status: "processing"; invocationArn: string; key: string; name: string; kind: string; size: number }
  | { status: "error"; error: string };

/** Begin ingesting an uploaded file (base64). Sandbox path returns ready
 *  immediately; BDA path returns a processing handle to poll. */
export async function startIngest(input: { name: string; b64: string; mime?: string }): Promise<StartResult> {
  const name = sanitizeName(input.name);
  const b64 = (input.b64 ?? "").replace(/^data:[^;]*;base64,/, "");
  if (!b64) return { status: "error", error: "empty file" };
  const size = Math.floor((b64.length * 3) / 4);
  if (b64.length > MAX_UPLOAD_BYTES * 1.4) return { status: "error", error: "file too large (max ~25MB)" };
  const ext = extOf(name);

  if (routeFor(ext) === "sandbox") {
    // Native extraction + keep the raw file for run_python.
    try {
      await writeFileB64(name, b64);
    } catch (err) {
      return { status: "error", error: `sandbox write failed: ${msg(err)}` };
    }
    const doc = await extractDocument(name);
    const { contextText, hasFullText } = buildContext("", doc.text || "(no text extracted)", outline(doc.kind, doc.meta));
    return {
      status: "ready",
      attachment: {
        name,
        kind: doc.kind,
        size,
        meta: doc.meta,
        contextText,
        hasFullText,
        chars: doc.chars,
        status: "ready",
        ...(doc.error ? { note: doc.error } : {}),
      },
    };
  }

  // BDA path: put to S3, start async extraction.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `uploads/${stamp}/${name}`;
  try {
    await putObject(key, Buffer.from(b64, "base64"), input.mime);
  } catch (err) {
    return { status: "error", error: `S3 upload failed: ${msg(err)}` };
  }
  try {
    const job = await startExtraction(key, `bda-out/${stamp}/`);
    if (!job.invocationArn) return { status: "error", error: "BDA did not start" };
    const kind = ext === "pdf" ? "pdf" : "image";
    return { status: "processing", invocationArn: job.invocationArn, key, name, kind, size };
  } catch (err) {
    return { status: "error", error: `BDA start failed: ${msg(err)}` };
  }
}

export type PollResult =
  | { status: "ready"; attachment: Attachment }
  | { status: "processing" }
  | { status: "error"; error: string };

/** Poll a BDA job; when done, parse + store markdown and build the Attachment. */
export async function pollIngest(input: { invocationArn: string; key: string; name: string; kind: string; size: number }): Promise<PollResult> {
  let st;
  try {
    st = await getStatus(input.invocationArn);
  } catch (err) {
    return { status: "error", error: `status check failed: ${msg(err)}` };
  }
  if (st.status === "ServiceError" || st.status === "ClientError") {
    return { status: "error", error: st.error || st.status };
  }
  if (st.status !== "Success" || !st.outputS3Uri) return { status: "processing" };

  let res;
  try {
    res = await readResult(st.outputS3Uri);
  } catch (err) {
    return { status: "error", error: `result read failed: ${msg(err)}` };
  }
  const markdown = res.markdown || "(no text extracted)";
  const markdownKey = `${input.key}.md`;
  try {
    await putText(markdownKey, markdown);
  } catch {
    /* non-fatal: retrieval will fall back to the injected preview */
  }
  const { contextText, hasFullText } = buildContext(res.summary, markdown, outline(input.kind, { pages: res.pages }));
  return {
    status: "ready",
    attachment: {
      name: input.name,
      kind: input.kind,
      size: input.size,
      meta: { pages: res.pages, tables: res.tablesCsv.length },
      contextText,
      hasFullText,
      chars: markdown.length,
      markdownKey,
      status: "ready",
    },
  };
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
