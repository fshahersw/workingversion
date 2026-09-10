// Browser helpers for the platform Slides host: file pickers, downloads, and
// deck creation through the platform (PPTX uploads become revision 1; a new
// blank deck is built in the browser with the vendored pptx-engine).
import type { OfficeDocSummary } from "@/lib/office/types";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_UPLOAD = 30 * 1024 * 1024;

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function platformFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    const value = (await res.json().catch(() => ({}))) as { error?: string };
    throw new RequestError(res.status, value.error || "The document request failed.");
  }
  return res;
}

export async function createDeck(
  name: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<OfficeDocSummary> {
  const body = bytes instanceof Uint8Array ? new Blob([bytes as BlobPart]) : new Blob([bytes]);
  const res = await platformFetch("/api/office/docs", {
    method: "POST",
    headers: {
      "Content-Type": PPTX_MIME,
      "X-Office-Kind": "pptx",
      "X-Office-Filename": encodeURIComponent(name),
    },
    body,
  });
  return (await res.json()) as OfficeDocSummary;
}

/**
 * A one-slide blank 16:9 deck, built the same way the desktop app's File > New
 * does. pptx-engine needs Node APIs, so the platform server builds it.
 */
export async function createBlankDeck(name = "Untitled.pptx"): Promise<OfficeDocSummary> {
  const { createBlankDeckFn } = await import("@/lib/office/office.functions");
  return createBlankDeckFn({ data: { name } });
}

export async function uploadDeck(file: File): Promise<OfficeDocSummary> {
  if (file.size > MAX_UPLOAD) throw new Error("Choose a presentation up to 30 MB.");
  if (!/\.pptx$/i.test(file.name)) throw new Error("Choose a PowerPoint presentation (.pptx).");
  return createDeck(file.name, await file.arrayBuffer());
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

// The vendored drop-open bridge imports `uploadDocument` from this module.
export const uploadDocument = (file: File) => uploadDeck(file);
