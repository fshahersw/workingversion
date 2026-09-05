// ============================================================================
// Browser side of the ephemeral workspace.
//
// One streamed upload per file, then the server-side Docling workers do the
// conversion. This replaces the old per-page OCR fan-out: instead of hundreds
// of large base64 POSTs racing on one connection, each file is a handful of
// sequential binary slices.
// ============================================================================

export type ScratchUploadProgress = {
  documents: {
    documentId: string;
    name: string;
    pages: number;
    pagesDone: number;
    status: string;
    error: string | null;
  }[];
  jobs: Record<string, number>;
  pages: Record<string, number>;
  chunks: number;
  session: Record<string, unknown> | null;
};

export type ScratchConvertedPage = {
  pageId: number;
  documentId: string;
  documentName: string;
  page: number;
  source: string;
  markdown: string;
};

const SLICE_BYTES = 3 * 1024 * 1024;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createScratchWorkspace(input: {
  label?: string | null;
  instructions?: string | null;
}): Promise<string> {
  const session = await json<{ session_id: string }>("/api/pile/scratch/session", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return session.session_id;
}

/**
 * Upload one PDF and queue it. `ocrPages` are the 1-indexed pages the local
 * text extraction found unreadable — only those spans pay for OCR.
 */
export async function uploadScratchDocument(
  sessionId: string,
  file: File,
  opts: {
    pageCount: number;
    ocrPages: number[];
    onProgress?: (bytesSent: number, bytesTotal: number) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const sha256 = await sha256Hex(file);
  const reg = await json<{ documentId: string; reused: boolean }>(
    `/api/pile/scratch/session/${sessionId}/document`,
    {
      method: "POST",
      body: JSON.stringify({ name: file.name, sha256, byteSize: file.size }),
      signal: opts.signal ?? null,
    },
  );
  if (reg.reused) return reg.documentId;

  for (let offset = 0; offset < file.size; offset += SLICE_BYTES) {
    const slice = file.slice(offset, Math.min(offset + SLICE_BYTES, file.size));
    const res = await fetch(`/api/pile/scratch/document/${reg.documentId}/bytes`, {
      method: "POST",
      body: await slice.arrayBuffer(),
      headers: { "Content-Type": "application/octet-stream" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Upload failed (HTTP ${res.status})`);
    }
    opts.onProgress?.(Math.min(offset + SLICE_BYTES, file.size), file.size);
  }

  await json(`/api/pile/scratch/document/${reg.documentId}/enqueue`, {
    method: "POST",
    body: JSON.stringify({ pageCount: opts.pageCount, ocrPages: opts.ocrPages }),
    signal: opts.signal ?? null,
  });
  return reg.documentId;
}

export async function scratchProgress(sessionId: string): Promise<ScratchUploadProgress> {
  return json<ScratchUploadProgress>(`/api/pile/scratch/session/${sessionId}`);
}

export async function scratchPages(
  sessionId: string,
  after = 0,
): Promise<{ pages: ScratchConvertedPage[]; cursor: number }> {
  return json(`/api/pile/scratch/session/${sessionId}/pages?after=${after}&limit=1000`);
}

export function scratchIsIdle(p: ScratchUploadProgress): boolean {
  const pending = Object.entries(p.jobs)
    .filter(([k]) => k.startsWith("queued:") || k.startsWith("running:"))
    .reduce((n, [, v]) => n + v, 0);
  return pending === 0;
}

/**
 * Poll until every span is done, streaming converted pages back as they land.
 * Returns the final progress snapshot.
 */
export async function awaitScratchConversion(
  sessionId: string,
  onPages: (pages: ScratchConvertedPage[], progress: ScratchUploadProgress) => void,
  signal?: AbortSignal,
): Promise<ScratchUploadProgress> {
  let cursor = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const progress = await scratchProgress(sessionId);
    const batch = await scratchPages(sessionId, cursor);
    if (batch.pages.length) {
      cursor = batch.cursor;
      onPages(batch.pages, progress);
    } else {
      onPages([], progress);
    }
    if (scratchIsIdle(progress) && !batch.pages.length) return progress;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function deleteScratchWorkspace(sessionId: string): Promise<void> {
  await fetch(`/api/pile/scratch/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}
