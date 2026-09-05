// ============================================================================
// Ephemeral document workspace ("scratch") — session lifecycle + retrieval.
//
// The heavy work (Docling conversion, chunking, embedding) happens in the
// Python worker pool: scripts/pipeline/scratch_worker.py. The app only
// registers documents, streams their bytes in, reports progress, and searches.
//
// Nothing here writes to object storage. Raw bytes are dropped by the worker
// the moment a document finishes; scratch.sweep() enforces the hard ceilings.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

import { CORPUS_URL } from "@/lib/corpus";

const service = () =>
  createClient(CORPUS_URL, process.env["CORPUS_SERVICE_KEY"] ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export function scratchConfigured(): boolean {
  return Boolean(process.env["CORPUS_SERVICE_KEY"]);
}

/** Bytes per append call. Keeps every upload request small and retryable. */
export const UPLOAD_SLICE_BYTES = 3 * 1024 * 1024;
/** Pages per worker job. Matches the worker's span assumption. */
export const SPAN_PAGES = 50;

export type ScratchSession = {
  session_id: string;
  label: string | null;
  instructions: string | null;
  owner_email: string | null;
  status: string;
  error: string | null;
  created_at: string;
  expires_at: string;
};

export type ScratchHit = {
  chunkId: number;
  documentId: string;
  documentName: string;
  pageStart: number;
  pageEnd: number;
  headingPath: string | null;
  content: string;
  score: number;
};

function fail(msg: string, detail?: unknown): never {
  throw new Error(detail ? `${msg}: ${String(detail)}` : msg);
}

// --- lifecycle ---------------------------------------------------------------

export async function createScratchSession(input: {
  label?: string | null;
  instructions?: string | null;
  ownerEmail?: string | null;
}): Promise<ScratchSession> {
  const { data, error } = await service()
    .from("scratch_sessions")
    .insert({
      label: input.label?.trim() || null,
      instructions: input.instructions?.trim() || null,
      owner_email: input.ownerEmail ?? null,
    })
    .select("*")
    .single();
  if (error) fail("Could not create workspace", error.message);
  // Retention is enforced in the database; creating a workspace is a
  // convenient, idempotent moment to run the sweep even when no worker is up.
  void service().rpc("scratch_sweep");
  return data as ScratchSession;
}

export async function getScratchSession(id: string): Promise<ScratchSession | null> {
  const { data } = await service()
    .from("scratch_sessions")
    .select("*")
    .eq("session_id", id)
    .maybeSingle();
  return (data as ScratchSession | null) ?? null;
}

export async function touchScratchSession(id: string): Promise<void> {
  // rolling 3-day window, refreshed on access
  await service()
    .from("scratch_sessions")
    .update({
      accessed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("session_id", id);
}

export async function deleteScratchSession(id: string): Promise<void> {
  const { error } = await service().from("scratch_sessions").delete().eq("session_id", id);
  if (error) fail("Could not delete workspace", error.message);
}

// --- upload ------------------------------------------------------------------

/** Register a document and return its id. Re-uses an identical prior upload. */
export async function registerScratchDocument(input: {
  sessionId: string;
  name: string;
  sha256: string;
  byteSize: number;
}): Promise<{ documentId: string; reused: boolean }> {
  const db = service();
  const { data: existing } = await db
    .from("scratch_documents")
    .select("document_id,status")
    .eq("session_id", input.sessionId)
    .eq("sha256", input.sha256)
    .maybeSingle();
  if (existing?.document_id) {
    return { documentId: existing.document_id as string, reused: true };
  }
  const { data, error } = await db
    .from("scratch_documents")
    .insert({
      session_id: input.sessionId,
      name: input.name.slice(0, 300),
      sha256: input.sha256,
      byte_size: input.byteSize,
    })
    .select("document_id")
    .single();
  if (error) fail("Could not register document", error.message);
  return { documentId: (data as { document_id: string }).document_id, reused: false };
}

/** Append one base64 slice of the PDF. Returns the total bytes stored so far. */
export async function appendScratchBytes(documentId: string, chunkB64: string): Promise<number> {
  const { data, error } = await service().rpc("scratch_append_bytes", {
    p_document: documentId,
    p_chunk_b64: chunkB64,
  });
  if (error) fail("Upload slice rejected", error.message);
  return Number(data ?? 0);
}

/**
 * Fan the document out into span jobs. `ocrPages` are the 1-indexed pages the
 * client found to have no usable text layer — those spans go to the GPU queue.
 */
export async function enqueueScratchDocument(input: {
  documentId: string;
  pageCount: number;
  ocrPages: number[];
}): Promise<number> {
  const { data, error } = await service().rpc("scratch_enqueue_document", {
    p_document: input.documentId,
    p_page_count: input.pageCount,
    p_ocr_pages: input.ocrPages.slice(0, 20000),
    p_span: SPAN_PAGES,
  });
  if (error) fail("Could not queue document", error.message);
  return Number(data ?? 0);
}

// --- progress ----------------------------------------------------------------

export type ScratchProgress = {
  session: Record<string, unknown> | null;
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
};

export async function scratchProgress(sessionId: string): Promise<ScratchProgress> {
  const { data, error } = await service().rpc("scratch_progress", { p_session: sessionId });
  if (error) fail("Could not read progress", error.message);
  return data as ScratchProgress;
}

// --- retrieval ---------------------------------------------------------------

/** Query-time embedding. Voyage keeps query and document vectors comparable. */
async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env["VOYAGE_API_KEY"];
  if (!key) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "voyage-law-2", input: [text], input_type: "query" }),
    });
    if (!res.ok) return null; // keyword arm alone still answers
    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    return json.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

export async function searchScratch(
  sessionId: string,
  query: string,
  limit = 20,
): Promise<ScratchHit[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await service().rpc("scratch_hybrid_search", {
    p_session: sessionId,
    p_query: query,
    p_embedding: embedding ? `[${embedding.join(",")}]` : null,
    p_limit: limit,
  });
  if (error) fail("Search failed", error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  return rows.map((r) => ({
    chunkId: Number(r["chunk_id"]),
    documentId: String(r["document_id"]),
    documentName: String(r["document_name"] ?? ""),
    pageStart: Number(r["page_start"]),
    pageEnd: Number(r["page_end"]),
    headingPath: (r["heading_path"] as string | null) ?? null,
    content: String(r["content"] ?? ""),
    score: Number(r["score"] ?? 0),
  }));
}

/** Precision pass over fused candidates; falls back to RRF order. */
export async function rerankScratchHits(
  query: string,
  hits: ScratchHit[],
  topK = 8,
): Promise<ScratchHit[]> {
  const key = process.env["VOYAGE_API_KEY"];
  if (!key || hits.length <= topK) return hits.slice(0, Math.max(topK, 1));
  try {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "rerank-2.5",
        query,
        documents: hits.map((h) => h.content.slice(0, 1800)),
        top_k: topK,
      }),
    });
    if (!res.ok) return hits.slice(0, topK);
    const json = (await res.json()) as { data?: { index: number }[] };
    const ranked = (json.data ?? [])
      .map((d) => hits[d.index])
      .filter((h): h is ScratchHit => Boolean(h));
    return ranked.length ? ranked : hits.slice(0, topK);
  } catch {
    return hits.slice(0, topK);
  }
}

// --- page hydration ----------------------------------------------------------

export type ScratchPage = {
  pageId: number;
  documentId: string;
  documentName: string;
  page: number;
  source: string;
  markdown: string;
};

/**
 * Pull converted pages back out in id order. The client hydrates its local
 * reading view from these, so the source panel keeps working unchanged.
 */
export async function fetchScratchPages(
  sessionId: string,
  afterId = 0,
  limit = 500,
): Promise<ScratchPage[]> {
  const db = service();
  const [pagesRes, docsRes] = await Promise.all([
    db
      .from("scratch_pages")
      .select("page_id,document_id,page_no,source,markdown")
      .eq("session_id", sessionId)
      .gt("page_id", afterId)
      .order("page_id", { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 2000)),
    db.from("scratch_documents").select("document_id,name").eq("session_id", sessionId),
  ]);
  if (pagesRes.error) fail("Could not read pages", pagesRes.error.message);
  const names = new Map(
    ((docsRes.data ?? []) as { document_id: string; name: string }[]).map((d) => [
      d.document_id,
      d.name,
    ]),
  );
  return ((pagesRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    pageId: Number(r["page_id"]),
    documentId: String(r["document_id"]),
    documentName: names.get(String(r["document_id"])) ?? "",
    page: Number(r["page_no"]),
    source: String(r["source"] ?? "text"),
    markdown: String(r["markdown"] ?? ""),
  }));
}
