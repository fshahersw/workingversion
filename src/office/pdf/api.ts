import type { OfficeDocSummary } from "@/lib/office/types";
export async function pdfRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The PDF request failed.");
  return response;
}
export async function createPdfDocument(name: string, bytes: Uint8Array): Promise<OfficeDocSummary> {
  const response = await pdfRequest("/api/office/docs", { method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Office-Kind": "pdf", "X-Office-Filename": encodeURIComponent(name) },
    body: new Blob([bytes as BlobPart]),
  });
  return response.json();
}
export function downloadPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a"); link.href = url; link.download = name;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
