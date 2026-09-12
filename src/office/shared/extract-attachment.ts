import { joinExtraction } from "@/lib/agents/attachment-pages";
import type { ExtractHandle, ExtractResult } from "@/lib/office/attachments.server";

export const OFFICE_LOCAL_TEXT_EXTS = new Set(["txt", "md", "json", "csv"]);
export const OFFICE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const OFFICE_EXTRACT_EXTS = new Set([
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "xlsm",
  "xls",
  "html",
  "htm",
  "rtf",
  "tif",
  "tiff",
  "bmp",
]);
export const OFFICE_ATTACHMENT_ACCEPT =
  ".txt,.md,.json,.csv,.pdf,.docx,.pptx,.xlsx,.xlsm,.xls,.html,.htm,.rtf,.tif,.tiff,.bmp,.png,.jpg,.jpeg,.gif,.webp";

export const OFFICE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const OFFICE_MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Larger binaries upload directly to S3 with an integrity-bound URL. */
export const OFFICE_MAX_EXTRACT_BYTES = 25 * 1024 * 1024;

export function classifyOfficeAttachment(
  ext: string,
  size: number,
): { ok: true } | { ok: false; error: string } {
  if (OFFICE_IMAGE_EXTS.has(ext)) {
    return size <= OFFICE_MAX_IMAGE_BYTES
      ? { ok: true }
      : { ok: false, error: "Images are limited to 5 MB." };
  }
  if (OFFICE_LOCAL_TEXT_EXTS.has(ext)) {
    return size <= OFFICE_MAX_TEXT_BYTES
      ? { ok: true }
      : { ok: false, error: "Text files are limited to 5 MB." };
  }
  if (OFFICE_EXTRACT_EXTS.has(ext)) {
    return size <= OFFICE_MAX_EXTRACT_BYTES
      ? { ok: true }
      : { ok: false, error: "PDF and Office attachments are limited to 25 MB." };
  }
  return { ok: false, error: "Use a PDF, Word, PowerPoint, Excel, text, or image file." };
}

function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The attachment could not be read."));
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^;]*;base64,/, ""));
    reader.readAsDataURL(file);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract text for one binary/scan attachment. Throws a short user-facing error. */
export async function extractOfficeAttachment(file: File): Promise<string> {
  const api = await import("@/lib/office/tools.functions");
  let res: ExtractResult;
  if (file.size > OFFICE_MAX_EXTRACT_BYTES) throw new Error("Attachments are limited to 25 MB.");
  if (file.size > 3.5 * 1024 * 1024) {
    const bytes = await file.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((n) => n.toString(16).padStart(2, "0")).join("");
    const grant = await api.officePrepareAttachmentUploadFn({
      data: { name: file.name, mime: file.type, size: file.size, sha256 },
    });
    let upload: Response;
    try {
      upload = await fetch(grant.url, {
        method: "PUT",
        body: file,
        headers: { "x-amz-checksum-sha256": btoa(String.fromCharCode(...digest)) },
      });
    } catch {
      throw new Error(
        "Direct attachment upload could not reach storage. Check the connection and storage CORS for this app origin, then retry.",
      );
    }
    if (!upload.ok)
      throw new Error(`Attachment upload failed (${upload.status}). Retry the upload.`);
    res = await api.officeFinishAttachmentUploadFn({ data: { key: grant.key } });
  } else {
    res = await api.officeExtractAttachmentFn({
      data: { name: file.name, b64: await fileToB64(file), mime: file.type },
    });
  }
  const deadline = Date.now() + 15 * 60_000;
  while (res.status === "processing" && Date.now() < deadline) {
    await sleep(3000);
    res = await api.officePollAttachmentFn({ data: res.handle as ExtractHandle });
  }
  if (res.status === "error") throw new Error(res.error);
  if (res.status !== "ready")
    throw new Error("Text extraction is still processing. Retry this attachment later.");
  const pages = [res.text];
  let index = res.nextChunk;
  while (index !== null) {
    const page = await api.officeReadAttachmentPageFn({ data: { cacheKey: res.cacheKey, index } });
    if (
      page.index !== index ||
      page.totalChars !== res.totalChars ||
      page.totalChunks !== res.totalChunks ||
      (page.nextChunk !== null && page.nextChunk !== index + 1)
    )
      throw new Error("Attachment pages changed. Retry extraction.");
    pages.push(page.text);
    index = page.nextChunk;
  }
  return `Attachment source handle: ${res.cacheKey} (use load_attachment_for_python to access the original file).\nExtraction coverage: ${res.coverage}\n\n${joinExtraction(pages, res.totalChars, res.totalChunks)}`;
}
