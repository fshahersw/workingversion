// ============================================================================
// Office assistant attachment extraction (server-only).
//
// Browsers can read plain text and DOCX locally, but PDFs (born-digital or
// scanned), TIFF/BMP scans and PPTX/XLSX need a real extractor. This module
// reuses the Research upload pipeline:
//  - BDA (pdf, tif, tiff, bmp): Bedrock Data Automation OCRs the file and
//    returns page-anchored markdown plus a short summary. Async; the caller
//    polls with the returned handle.
//  - Sandbox (docx, pptx, xlsx, xlsm, csv, …): the code interpreter extracts
//    text natively. Synchronous.
// Results are cached by content hash under `office-attachments/<sha256>.md`
// so re-attaching the same file (or another user attaching the same exhibit)
// never re-runs OCR. No document text is logged.
// ============================================================================
import { createHash } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { getStatus, putObject, putText, readResult, startExtraction } from "@/lib/agents/bda.server";
import { extractDocument, writeFileB64 } from "@/lib/agents/code-interpreter.server";
import { extOf, sanitizeName } from "@/lib/agents/ingest.server";
import { bucketName, s3 } from "@/lib/data/s3.server";

import { OfficeError } from "./office.server";

export const OFFICE_OCR_EXTS = new Set(["pdf", "tif", "tiff", "bmp"]);
export const OFFICE_SANDBOX_EXTS = new Set(["docx", "pptx", "xlsx", "xlsm", "xls", "csv", "html", "htm", "rtf"]);
/** 25 MB decoded ceiling, matching the Research upload path. */
export const OFFICE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Extracted text cap handed back to the browser (chars). */
const MAX_TEXT_CHARS = 2_000_000;

export type ExtractHandle = { invocationArn: string; cacheKey: string; name: string; kind: "pdf" | "image" };

export type ExtractResult =
  | { status: "ready"; name: string; kind: string; text: string; pages?: number; summary?: string; cached?: boolean }
  | { status: "processing"; handle: ExtractHandle }
  | { status: "error"; error: string };

function cacheKeyFor(bytes: Uint8Array): string {
  return `office-attachments/${createHash("sha256").update(bytes).digest("hex")}.md`;
}

async function readCached(cacheKey: string): Promise<{ text: string; pages?: number; summary?: string } | null> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: cacheKey }));
    const raw = (await r.Body?.transformToString()) ?? "";
    if (!raw) return null;
    // Header line: JSON metadata, then a blank line, then the markdown.
    const nl = raw.indexOf("\n\n");
    if (nl < 0) return { text: raw };
    try {
      const meta = JSON.parse(raw.slice(0, nl)) as { pages?: number; summary?: string };
      return { text: raw.slice(nl + 2), ...(meta.pages ? { pages: meta.pages } : {}), ...(meta.summary ? { summary: meta.summary } : {}) };
    } catch {
      return { text: raw };
    }
  } catch {
    return null;
  }
}

async function writeCached(cacheKey: string, text: string, meta: { pages?: number; summary?: string }): Promise<void> {
  try {
    await putText(cacheKey, `${JSON.stringify(meta)}\n\n${text}`);
  } catch {
    /* cache is best effort */
  }
}

/** Start (or finish, when synchronous or cached) extraction of one attachment. */
export async function startAttachmentExtract(input: { name: string; b64: string; mime?: string }): Promise<ExtractResult> {
  const name = sanitizeName(input.name);
  const ext = extOf(name);
  const b64 = (input.b64 ?? "").replace(/^data:[^;]*;base64,/, "");
  if (!b64) return { status: "error", error: "The attachment is empty." };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength > OFFICE_ATTACHMENT_MAX_BYTES) return { status: "error", error: "Attachments are limited to 25 MB." };
  if (!OFFICE_OCR_EXTS.has(ext) && !OFFICE_SANDBOX_EXTS.has(ext)) {
    return { status: "error", error: `Server extraction does not handle .${ext} files.` };
  }
  const cacheKey = cacheKeyFor(bytes);
  const cached = await readCached(cacheKey);
  if (cached) return { status: "ready", name, kind: OFFICE_OCR_EXTS.has(ext) ? (ext === "pdf" ? "pdf" : "image") : ext, cached: true, ...cached, text: cached.text.slice(0, MAX_TEXT_CHARS) };

  if (OFFICE_SANDBOX_EXTS.has(ext)) {
    try {
      const sandboxName = `office-${Date.now().toString(36)}-${name}`;
      await writeFileB64(sandboxName, b64);
      const doc = await extractDocument(sandboxName);
      const text = (doc.text || "").slice(0, MAX_TEXT_CHARS);
      if (!text.trim()) return { status: "error", error: doc.error || "No text could be extracted from the file." };
      const pages = typeof doc.meta["pages"] === "number" ? (doc.meta["pages"] as number) : typeof doc.meta["slides"] === "number" ? (doc.meta["slides"] as number) : undefined;
      await writeCached(cacheKey, text, { ...(pages ? { pages } : {}) });
      return { status: "ready", name, kind: doc.kind, text, ...(pages ? { pages } : {}) };
    } catch (error) {
      return { status: "error", error: `Extraction failed: ${message(error)}` };
    }
  }

  // OCR path: upload once, start the async BDA job; the browser polls.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `office-uploads/${stamp}/${name}`;
  try {
    await putObject(key, bytes, input.mime);
    const job = await startExtraction(key, `office-bda-out/${stamp}/`);
    if (!job.invocationArn) return { status: "error", error: "The OCR service did not start." };
    return { status: "processing", handle: { invocationArn: job.invocationArn, cacheKey, name, kind: ext === "pdf" ? "pdf" : "image" } };
  } catch (error) {
    return { status: "error", error: `OCR could not start: ${message(error)}` };
  }
}

/** Poll an OCR job; on success cache and return the page-anchored markdown. */
export async function pollAttachmentExtract(handle: ExtractHandle): Promise<ExtractResult> {
  if (!/^arn:aws[a-z-]*:bedrock:/.test(handle.invocationArn)) throw new OfficeError(422, "Invalid extraction handle.");
  if (!/^office-attachments\/[0-9a-f]{64}\.md$/.test(handle.cacheKey)) throw new OfficeError(422, "Invalid extraction handle.");
  let st;
  try {
    st = await getStatus(handle.invocationArn);
  } catch (error) {
    return { status: "error", error: `OCR status check failed: ${message(error)}` };
  }
  if (st.status === "ServiceError" || st.status === "ClientError") return { status: "error", error: st.error || "The OCR service reported an error." };
  if (st.status !== "Success" || !st.outputS3Uri) return { status: "processing", handle };
  try {
    const res = await readResult(st.outputS3Uri, { expectedOutputPrefix: "office-bda-out/" });
    const text = (res.markdown || "").slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) return { status: "error", error: "No text could be recognized in the file." };
    const meta = { ...(res.pages ? { pages: res.pages } : {}), ...(res.summary ? { summary: res.summary.slice(0, 2000) } : {}) };
    await writeCached(handle.cacheKey, text, meta);
    return { status: "ready", name: handle.name, kind: handle.kind, text, ...meta };
  } catch (error) {
    return { status: "error", error: `OCR result could not be read: ${message(error)}` };
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
