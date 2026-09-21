import { validatePdf, visiblePageBox } from "./document";
import type { PdfiumRequest, PdfNativeObject, PdfNativeEdit, PdfNativeImageEdit } from "./pdfium-core";
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (active < 2) { active++; return; }
  if (waiters.length >= 8) throw new Error("The PDF engine has too many queued requests. Wait for the current reads to finish.");
  await new Promise<void>((resolve, reject) => {
    const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { const index = waiters.indexOf(ready); if (index >= 0) waiters.splice(index, 1); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    waiters.push(ready); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function release() { const next = waiters.shift(); if (next) next(); else active--; }
export async function runPdfium(bytes: Uint8Array, pages: number[], operations?: Array<PdfNativeEdit | PdfNativeImageEdit>, signal?: AbortSignal): Promise<{ objects: PdfNativeObject[]; bytes?: Uint8Array }> {
  await acquire(signal);
  try {
  signal?.throwIfAborted();
  const doc = await validatePdf(bytes); signal?.throwIfAborted();
  const request: PdfiumRequest = { bytes: bytes.slice(), pages, boxes: doc.getPages().map(visiblePageBox), ...(operations ? { operations } : {}) };
  const worker = new Worker(new URL("./pdfium.worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<{ objects: PdfNativeObject[]; bytes?: Uint8Array }>((resolve, reject) => {
    const finish = (error?: Error, result?: { objects: PdfNativeObject[]; bytes?: Uint8Array }) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); worker.terminate(); if (error) reject(error); else resolve(result!); };
    const abort = () => finish(new DOMException("PDF operation cancelled. Original bytes are unchanged.", "AbortError"));
    const timeout = setTimeout(() => finish(new Error("PDF native operation exceeded 30 seconds. Original bytes are unchanged.")), 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("The browser PDF engine failed. Original bytes are unchanged."));
    worker.onmessage = event => event.data.ok ? finish(undefined, event.data.result) : finish(new Error(event.data.error));
    if (signal?.aborted) abort(); else { try { worker.postMessage(request, [request.bytes.buffer]); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } }
  });
  signal?.throwIfAborted();
  if (result.bytes) await validatePdf(result.bytes);
  signal?.throwIfAborted(); return result;
  } finally { release(); }
}
