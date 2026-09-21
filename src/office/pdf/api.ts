import type { OfficeDocSummary } from "@/lib/office/types";
import { deliverOfficeFile } from "../shared/file-delivery";
export async function pdfRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The PDF request failed.");
  return response;
}
export async function createPdfDocument(name: string, bytes: Uint8Array): Promise<OfficeDocSummary> {
  if (bytes.byteLength > 3 * 1024 * 1024) return (await import("../shared/create-transfer")).createLargeOfficeDocument("pdf", name, bytes);
  const response = await pdfRequest("/api/office/docs", { method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Office-Kind": "pdf", "X-Office-Filename": encodeURIComponent(name) },
    body: new Blob([bytes as BlobPart]),
  });
  return response.json();
}
export function downloadPdf(bytes: Uint8Array, name: string) {
  deliverOfficeFile(new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
}
export function downloadSavedPdf(docId: string, version: number, name: string) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(docId) || !Number.isSafeInteger(version) || version < 1)
    throw new Error("A saved PDF revision is required for download.");
  deliverOfficeFile(`/api/office/docs/${docId}/content?version=${version}&download=1`, name);
}
