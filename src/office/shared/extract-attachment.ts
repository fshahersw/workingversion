/**
 * Office chat-attachment extraction. Plain text stays in the browser. PDFs
 * (including scans), TIFF/BMP, and Office binaries go through the platform
 * extractor (BDA OCR or the code-interpreter sandbox) and are cached in
 * memory for the rest of the session so paging does not re-run OCR.
 *
 * Payload is capped so the JSON request stays under the Lambda 6 MB invoke
 * limit. Larger exhibits belong on the Research upload path.
 */
type ExtractHandle = { invocationArn: string; cacheKey: string; name: string; kind: "pdf" | "image" };
type ExtractResult =
  | { status: "ready"; text: string }
  | { status: "processing"; handle: ExtractHandle }
  | { status: "error"; error: string };

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
/** Decoded size. Base64 plus JSON must stay under the Lambda 6 MB request cap. */
export const OFFICE_MAX_EXTRACT_BYTES = 3.5 * 1024 * 1024;

export function classifyOfficeAttachment(ext: string, size: number): { ok: true } | { ok: false; error: string } {
  if (OFFICE_IMAGE_EXTS.has(ext)) {
    return size <= OFFICE_MAX_IMAGE_BYTES ? { ok: true } : { ok: false, error: "Images are limited to 5 MB." };
  }
  if (OFFICE_LOCAL_TEXT_EXTS.has(ext)) {
    return size <= OFFICE_MAX_TEXT_BYTES ? { ok: true } : { ok: false, error: "Text files are limited to 5 MB." };
  }
  if (OFFICE_EXTRACT_EXTS.has(ext)) {
    return size <= OFFICE_MAX_EXTRACT_BYTES
      ? { ok: true }
      : { ok: false, error: "PDF and Office attachments are limited to 3.5 MB so they can be sent for OCR." };
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
  const { officeExtractAttachmentFn, officePollAttachmentFn } = await import("@/lib/office/tools.functions");
  const b64 = await fileToB64(file);
  let res = (await officeExtractAttachmentFn({
    data: { name: file.name, b64, ...(file.type ? { mime: file.type } : {}) },
  })) as ExtractResult;
  if (res.status === "error") throw new Error(res.error);
  if (res.status === "ready") return res.text;
  let handle: ExtractHandle = res.handle;
  for (let i = 0; i < 70; i++) {
    await sleep(3000);
    res = (await officePollAttachmentFn({ data: handle })) as ExtractResult;
    if (res.status === "error") throw new Error(res.error);
    if (res.status === "ready") return res.text;
    if (res.status === "processing") handle = res.handle;
  }
  throw new Error("Text extraction timed out. Try a shorter file, or open it in Research.");
}
