// Owner-scoped, versioned extraction manifests. Every text page is persisted;
// incomplete extraction never becomes a successful attachment.
import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getStatus,
  putObject,
  putText,
  readResult,
  startExtraction,
} from "@/lib/agents/bda.server";
import {
  extractDocument,
  readExtractedPage,
  writeFileB64,
} from "@/lib/agents/code-interpreter.server";
import { interpreterOwner } from "@/lib/agents/interpreter-context.server";
import { splitExtraction } from "@/lib/agents/attachment-pages";
import { extOf, sanitizeName } from "@/lib/agents/ingest.server";
import { bucketName, presignPut, s3, verifyUploadedObject } from "@/lib/data/s3.server";

export const OFFICE_OCR_EXTS = new Set(["pdf", "tif", "tiff", "bmp"]);
export const OFFICE_SANDBOX_EXTS = new Set([
  "docx",
  "pptx",
  "xlsx",
  "xlsm",
  "xls",
  "csv",
  "html",
  "htm",
  "rtf",
]);
export const OFFICE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const root = () => `office-attachments/v2/${hash(interpreterOwner())}/`;
const ownedKey = (key: string) => {
  if (!key.startsWith(root()) || !/^[a-zA-Z0-9/_-]+$/.test(key))
    throw new Error("Invalid attachment handle.");
  return key;
};
export type ExtractHandle = {
  invocationArn: string;
  cacheKey: string;
  name: string;
  kind: "pdf" | "image";
};
type Meta = {
  name: string;
  kind: string;
  sourceKey: string;
  pages?: number;
  summary?: string;
  coverage: string;
  totalChars: number;
  totalChunks: number;
};
type Ready = Meta & {
  status: "ready";
  text: string;
  cacheKey: string;
  nextChunk: number | null;
  cached?: boolean;
};
export type ExtractResult =
  | Ready
  | { status: "processing"; handle: ExtractHandle }
  | { status: "error"; error: string };
async function readText(key: string): Promise<string> {
  const result = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  if (!result.Body) throw new Error("Attachment content is unavailable.");
  return result.Body.transformToString();
}
async function json<T>(key: string): Promise<T> {
  return JSON.parse(await readText(key)) as T;
}
async function ready(cacheKey: string, cached = false): Promise<Ready> {
  const meta = await json<Meta>(`${ownedKey(cacheKey)}/manifest.json`);
  const text = await readText(`${cacheKey}/0.txt`);
  return {
    ...meta,
    status: "ready",
    text,
    cacheKey,
    cached,
    nextChunk: meta.totalChunks > 1 ? 1 : null,
  };
}
async function persist(
  cacheKey: string,
  text: string,
  info: Omit<Meta, "totalChars" | "totalChunks">,
): Promise<Ready> {
  const chunks = splitExtraction(text);
  if (!chunks.length) throw new Error("No text was extracted.");
  // Four uploads at a time; publish the manifest only after every page succeeds.
  for (let i = 0; i < chunks.length; i += 4) {
    await Promise.all(
      chunks.slice(i, i + 4).map((chunk, j) => putText(`${cacheKey}/${i + j}.txt`, chunk)),
    );
  }
  const meta: Meta = { ...info, totalChars: text.length, totalChunks: chunks.length };
  await putText(`${cacheKey}/manifest.json`, JSON.stringify(meta));
  return {
    ...meta,
    status: "ready",
    text: chunks[0],
    cacheKey,
    nextChunk: chunks.length > 1 ? 1 : null,
  };
}
export async function readAttachmentPage(cacheKey: string, index: number) {
  const meta = await json<Meta>(`${ownedKey(cacheKey)}/manifest.json`);
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.totalChunks)
    throw new Error("Invalid attachment page.");
  return {
    text: await readText(`${cacheKey}/${index}.txt`),
    index,
    nextChunk: index + 1 < meta.totalChunks ? index + 1 : null,
    totalChars: meta.totalChars,
    totalChunks: meta.totalChunks,
  };
}
export async function startAttachmentExtract(input: {
  name: string;
  b64: string;
  mime?: string;
}): Promise<ExtractResult> {
  const name = sanitizeName(input.name),
    ext = extOf(name);
  const b64 = input.b64.replace(/^data:[^;]*;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || !b64.length)
    return { status: "error", error: "The attachment is empty or invalid." };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength > OFFICE_ATTACHMENT_MAX_BYTES)
    return { status: "error", error: "Attachments are limited to 25 MB." };
  if (!OFFICE_OCR_EXTS.has(ext) && !OFFICE_SANDBOX_EXTS.has(ext))
    return { status: "error", error: `Server extraction does not handle .${ext} files.` };
  const cacheKey = `${root()}text/${hash(bytes)}-${ext}`;
  try {
    return { ...(await ready(cacheKey, true)), name };
  } catch (error) {
    if (!["NoSuchKey", "NotFound"].includes(String((error as { name?: string }).name))) throw error;
  }
  const sourceKey = `${root()}originals/${hash(bytes)}-${ext}`;
  await putObject(sourceKey, bytes, input.mime);
  if (OFFICE_SANDBOX_EXTS.has(ext)) {
    try {
      const sandboxName = `office-${randomUUID()}-${name}`;
      await writeFileB64(sandboxName, b64);
      const doc = await extractDocument(sandboxName, { complete: true });
      if (doc.error) throw new Error(doc.error);
      const parts = [doc.text];
      let offset = doc.meta.nextOffset as number | null;
      while (offset != null) {
        const page = await readExtractedPage(sandboxName, offset);
        parts.push(page.text);
        offset = page.nextOffset;
      }
      const text = parts.join("");
      // Python counts Unicode code points; verify before converting to JS UTF-16 counts.
      let codePoints = 0;
      for (const _ of text) codePoints++;
      if (codePoints !== doc.chars) throw new Error("Native extraction was incomplete.");
      return await persist(cacheKey, text, {
        name,
        sourceKey,
        kind: doc.kind,
        coverage: String(doc.meta.coverage),
        ...(typeof doc.meta.slides === "number" ? { pages: doc.meta.slides } : {}),
      });
    } catch (error) {
      return { status: "error", error: `Extraction failed: ${message(error)}` };
    }
  }
  const stamp = randomUUID(),
    key = sourceKey;
  try {
    const outputPrefix = `${root()}ocr/${stamp}/`;
    const job = await startExtraction(key, outputPrefix);
    if (!job.invocationArn) throw new Error("The OCR service did not start.");
    const handle: ExtractHandle = {
      invocationArn: job.invocationArn,
      cacheKey,
      name,
      kind: ext === "pdf" ? "pdf" : "image",
    };
    await putText(
      `${root()}jobs/${hash(job.invocationArn)}.json`,
      JSON.stringify({ ...handle, outputPrefix, sourceKey }),
    );
    return { status: "processing", handle };
  } catch (error) {
    return { status: "error", error: `OCR could not start: ${message(error)}` };
  }
}
export async function pollAttachmentExtract(handle: ExtractHandle): Promise<ExtractResult> {
  ownedKey(handle.cacheKey);
  // Bind the invocation, content hash and exact output prefix to a server-created
  // job owned by this authenticated user; a caller-supplied ARN is insufficient.
  const job = await json<ExtractHandle & { outputPrefix: string; sourceKey: string }>(
    `${root()}jobs/${hash(handle.invocationArn)}.json`,
  );
  if (job.invocationArn !== handle.invocationArn || job.cacheKey !== handle.cacheKey)
    throw new Error("Invalid extraction handle.");
  try {
    const st = await getStatus(job.invocationArn);
    if (st.status === "ServiceError" || st.status === "ClientError")
      throw new Error(st.error || "OCR failed.");
    if (st.status !== "Success" || !st.outputS3Uri) return { status: "processing", handle: job };
    const res = await readResult(st.outputS3Uri, { expectedOutputPrefix: job.outputPrefix });
    if (!res.markdown?.trim()) throw new Error("No text could be recognized.");
    return await persist(job.cacheKey, res.markdown, {
      name: job.name,
      sourceKey: job.sourceKey,
      kind: job.kind,
      coverage:
        "OCR text with page anchors. OCR can misread text or miss visual elements; verify quotations and material facts against the original pages.",
      ...(res.pages ? { pages: res.pages } : {}),
      ...(res.summary ? { summary: res.summary.slice(0, 2000) } : {}),
    });
  } catch (error) {
    return { status: "error", error: `OCR result could not be read: ${message(error)}` };
  }
}

type Upload = {
  key: string;
  name: string;
  mime?: string;
  size: number;
  sha256: string;
  expiresAt: number;
};
export async function prepareAttachmentUpload(input: {
  name: string;
  mime?: string;
  size: number;
  sha256: string;
}) {
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > OFFICE_ATTACHMENT_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(input.sha256)
  )
    throw new Error("Invalid attachment size or checksum (maximum 25 MB).");
  const name = sanitizeName(input.name);
  if (!OFFICE_OCR_EXTS.has(extOf(name)) && !OFFICE_SANDBOX_EXTS.has(extOf(name)))
    throw new Error("Unsupported attachment type.");
  const id = randomUUID(),
    key = `${root()}direct/${id}`;
  const record: Upload = { ...input, name, key, expiresAt: Date.now() + 15 * 60_000 };
  await putText(`${key}.json`, JSON.stringify(record));
  return { key, url: await presignPut(key, Buffer.from(input.sha256, "hex").toString("base64")) };
}
export async function finishAttachmentUpload(key: string): Promise<ExtractResult> {
  ownedKey(key);
  const record = await json<Upload>(`${key}.json`);
  if (record.key !== key || record.expiresAt < Date.now())
    throw new Error("Attachment upload expired. Please retry.");
  await verifyUploadedObject(key, record.size, record.sha256);
  const object = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  const bytes = await object.Body?.transformToByteArray();
  if (!bytes || bytes.length !== record.size || hash(bytes) !== record.sha256)
    throw new Error("Attachment integrity check failed.");
  return startAttachmentExtract({
    name: record.name,
    mime: record.mime,
    b64: Buffer.from(bytes).toString("base64"),
  });
}
function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 250);
}

/** Copy an authorized, original attachment into the current Office Python task. */
export async function stageAttachmentInPython(cacheKey: string) {
  const meta = await json<Meta>(`${ownedKey(cacheKey)}/manifest.json`);
  ownedKey(meta.sourceKey);
  const object = await s3().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: meta.sourceKey }),
  );
  if (!object.ContentLength || object.ContentLength > OFFICE_ATTACHMENT_MAX_BYTES)
    throw new Error("Attachment size is invalid.");
  const bytes = await object.Body?.transformToByteArray();
  if (!bytes || bytes.length !== object.ContentLength)
    throw new Error("Original attachment is incomplete.");
  const name = `${hash(bytes).slice(0, 12)}-${sanitizeName(meta.name)}`;
  await writeFileB64(name, Buffer.from(bytes).toString("base64"));
  return { path: name, bytes: bytes.length, coverage: meta.coverage };
}
