// Browser helpers for the platform Sheets host: file pickers, downloads, and
// document creation through the platform (XLSX directly; CSV via the engine's
// converter so the source file never becomes a stored revision).
import type { OfficeDocSummary } from "@/lib/office/types";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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

export async function createWorkbook(
  name: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<OfficeDocSummary> {
  const body = bytes instanceof Uint8Array ? new Blob([bytes as BlobPart]) : new Blob([bytes]);
  const res = await platformFetch("/api/office/docs", {
    method: "POST",
    headers: {
      "Content-Type": XLSX_MIME,
      "X-Office-Kind": "xlsx",
      "X-Office-Filename": encodeURIComponent(name),
    },
    body,
  });
  return (await res.json()) as OfficeDocSummary;
}

/**
 * CSV -> XLSX in the browser (the retained gateway converter is pure JSZip).
 * Same bounds as the Office server import: UTF-8, 16 MB, 100k rows, 250k cells.
 * The user's CSV itself is never stored; the workbook is.
 */
export async function convertCsv(file: File): Promise<{ name: string; bytes: Uint8Array }> {
  if (file.size > 16 * 1024 * 1024) throw new RequestError(413, "CSV exceeds the 16 MB limit.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new RequestError(422, "CSV must use UTF-8 encoding.");
  }
  if (text.includes("\0")) throw new RequestError(422, "The upload is not ordinary CSV text.");
  let quotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (quotes && text[i + 1] === '"') i++;
      else quotes = !quotes;
    }
  }
  if (quotes) throw new RequestError(422, "CSV has an unterminated quoted field.");
  const { csvToXlsxBuffer, parseCsv } = await import("../src/gateway/csv-import");
  const rows = parseCsv(text);
  let cells = 0;
  for (const row of rows) {
    cells += row.length;
    if (row.length > 1024 || row.some((c) => c.length > 32767))
      throw new RequestError(413, "CSV has an oversized row or cell.");
  }
  if (rows.length > 100_000 || cells > 250_000) {
    throw new RequestError(413, "CSV exceeds the limit of 100,000 rows / 250,000 cells.");
  }
  return {
    name: file.name.replace(/\.csv$/i, ".xlsx"),
    bytes: new Uint8Array(await csvToXlsxBuffer(text)),
  };
}

export async function uploadWorkbook(file: File): Promise<OfficeDocSummary> {
  if (file.size > MAX_UPLOAD) throw new Error("Choose a workbook up to 30 MB.");
  if (/\.csv$/i.test(file.name)) {
    const converted = await convertCsv(file);
    return createWorkbook(converted.name, converted.bytes);
  }
  if (!/\.xlsx$/i.test(file.name))
    throw new Error("Choose an Excel workbook (.xlsx) or a CSV file.");
  return createWorkbook(file.name, await file.arrayBuffer());
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
export const uploadDocument = (file: File) => uploadWorkbook(file);
