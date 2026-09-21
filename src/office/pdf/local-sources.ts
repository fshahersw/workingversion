import { validatePdf } from "./document";
import { decodePdfImage, pdfImageMime } from "./image-source";
export type PdfLocalSource = { id: string; name: string; kind: "pdf" | "image"; pageCount?: number; bytes: Uint8Array };
export async function admitPdfLocalSource(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PdfLocalSource> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("Each source must be at most 30 MB.");
  const base = { id: crypto.randomUUID(), name: name.slice(0, 160), bytes: bytes.slice() };
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    const doc = await validatePdf(bytes); signal?.throwIfAborted(); return { ...base, kind: "pdf", pageCount: doc.getPageCount() };
  }
  pdfImageMime(bytes); await decodePdfImage(bytes, signal); signal?.throwIfAborted(); return { ...base, kind: "image" };
}
