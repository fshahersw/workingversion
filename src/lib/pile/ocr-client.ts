import { HttpStatusError, parseRetryAfterMs } from "@/lib/pile/async";

/** base64 JPEG -> raw bytes, so the request body stays ~33% smaller than JSON. */
function toBytes(imageBase64: string): Uint8Array {
  const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, "").trim();
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Convert one rendered page immediately. Throws HttpStatusError so withRetry can back off. */
export async function ocrPageImage(imageBase64: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/pile/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: toBytes(imageBase64) as unknown as BodyInit,
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) {
    throw new HttpStatusError(
      res.status,
      `HTTP ${res.status}: ${body.error ?? res.statusText}`,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  return body.text ?? "";
}
