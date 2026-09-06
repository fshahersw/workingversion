// Client helpers for the durable KB. The Working Set keeps its instant local
// pile as the default; these back the explicit "Save" write-through and the
// KB-backed search/reload. Server routes are Cognito-gated (credentials sent).
//
// MVP workspace: a single per-user default workspace for the working-set surface
// (RLS already scopes every row by the verified principal, so this constant just
// partitions a user's own saved docs). Named matters / shared workspaces are P5.

export const KB_WORKINGSET_WORKSPACE = "00000000-0000-0000-0000-000000000001";

export type KbSurface = "workingset" | "deposition" | "review";

export type KbIngestResult = { docId: string; chunkCount: number; pageCount: number };

export type KbSearchHit = {
  chunk_id: number;
  doc_id: string;
  page_start: number | null;
  page_end: number | null;
  kind: string | null;
  content: string;
  conf: number | null;
  score: number;
};

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `request failed [${res.status}]`);
  return data as T;
}

/** Persist one file's extracted pages to the KB (write-through). */
export function ingestFileToKb(
  input: {
    fileName: string;
    pages: { page: number; text: string }[];
    mime?: string;
    sha256?: string;
    byteSize?: number;
    workspaceId?: string;
    surface?: KbSurface;
  },
  signal?: AbortSignal,
): Promise<KbIngestResult> {
  return postJson<KbIngestResult>(
    "/api/kb/ingest",
    {
      workspaceId: input.workspaceId ?? KB_WORKINGSET_WORKSPACE,
      surface: input.surface ?? "workingset",
      fileName: input.fileName,
      ...(input.mime ? { mime: input.mime } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
      pages: input.pages,
    },
    signal,
  );
}

export type KbDocument = {
  doc_id: string;
  file_name: string;
  page_count: number | null;
  status: string;
  created_at: string;
  chunk_count: number;
};

/** List the caller's saved KB documents for a surface. */
export async function listKbDocuments(
  opts: { workspaceId?: string; surface?: KbSurface } = {},
  signal?: AbortSignal,
): Promise<KbDocument[]> {
  const qs = new URLSearchParams({
    workspaceId: opts.workspaceId ?? KB_WORKINGSET_WORKSPACE,
    surface: opts.surface ?? "workingset",
  });
  const res = await fetch(`/api/kb/documents?${qs.toString()}`, {
    credentials: "include",
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { documents?: KbDocument[]; error?: string };
  if (!res.ok) throw new Error(data?.error || `request failed [${res.status}]`);
  return data.documents ?? [];
}

/** Hybrid search over the user's saved KB. */
export async function searchKbApi(
  query: string,
  opts: { topK?: number; docIds?: string[]; workspaceId?: string; surface?: KbSurface } = {},
  signal?: AbortSignal,
): Promise<KbSearchHit[]> {
  const out = await postJson<{ hits?: KbSearchHit[] }>(
    "/api/kb/search",
    {
      workspaceId: opts.workspaceId ?? KB_WORKINGSET_WORKSPACE,
      surface: opts.surface ?? "workingset",
      query,
      ...(opts.topK ? { topK: opts.topK } : {}),
      ...(opts.docIds?.length ? { docIds: opts.docIds } : {}),
    },
    signal,
  );
  return out.hits ?? [];
}
