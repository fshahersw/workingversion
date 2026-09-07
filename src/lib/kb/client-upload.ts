// Browser helpers shared by the Working Set and Deposition save paths:
// hashing original bytes, presigned upload of the original file, and an
// abortable delay for status polling.
import { createUploadFn } from "@/lib/library/library.functions";

export async function rawFileSha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", aborted, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }
  });
}

/**
 * Upload one original file through the presigned PUT flow. Returns the owned
 * S3 key, or undefined when the upload failed: byte preservation is
 * best-effort and pages+chunks still save without it.
 */
export async function uploadOriginalBytes(
  file: { name: string; blob: Blob; sha256?: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const up = await createUploadFn({
      data: {
        name: file.name,
        size: file.blob.size,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
      },
    });
    const put = await fetch(up.uploadUrl, {
      method: "PUT",
      body: file.blob,
      signal,
      ...(up.uploadHeaders ? { headers: up.uploadHeaders } : {}),
    });
    return put.ok ? up.s3Key : undefined;
  } catch {
    return undefined;
  }
}
