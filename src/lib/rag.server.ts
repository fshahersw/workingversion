// ============================================================================
// RAG retrieval over the v2 corpus (server-only).
//
// Hybrid search: semantic leg (voyage-law-2 query embeddings, 1024-dim) and
// keyword leg (stored tsvector) are fused with Reciprocal Rank Fusion inside
// Postgres (public.corpus_hybrid_match_chunks). An optional Voyage rerank-2.5
// pass re-orders the fused candidates for precision. Also exposes pinpoint
// document reads (public.corpus_read_document_chunks) so agents can pull full
// page context around a hit before quoting.
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { CORPUS_URL, MATTERS_BUCKET } from "./corpus";
import { presignS3Get } from "./s3.server";

const service = () =>
  createClient(CORPUS_URL, process.env["CORPUS_SERVICE_KEY"] ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export function ragConfigured(): boolean {
  return Boolean(process.env["CORPUS_SERVICE_KEY"]);
}

// --- Types -------------------------------------------------------------------

export type RagFilters = {
  matterId?: string;
  docType?: string;
  entryNumber?: number;
  documentId?: string;
  party?: string;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  minSimilarity?: number;
};

export type RagHit = {
  chunkId: string;
  documentId: string;
  matterId: string;
  entryNumber: number | null;
  attachmentNumber: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  docType: string | null;
  dateFiled: string | null;
  content: string;
  rrfScore: number;
  vectorRank: number | null;
  keywordRank: number | null;
  similarity: number | null;
  caseName: string;
  shortName: string | null;
  docketNumber: string;
  slug: string;
  docTitle: string | null;
  entryLabel: string | null;
  s3Key: string | null;
  courtlistenerUrl: string | null;
};

export type DocumentChunk = {
  chunkId: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
};

export type DocumentRead = {
  doc: Record<string, unknown>;
  matter: Record<string, unknown> | null;
  chunks: DocumentChunk[];
};

// --- Mapping -----------------------------------------------------------------

const txt = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function mapHit(r: Record<string, unknown>): RagHit {
  return {
    chunkId: String(r["chunk_id"]),
    documentId: String(r["document_id"]),
    matterId: String(r["matter_id"]),
    entryNumber: num(r["entry_number"]),
    attachmentNumber: num(r["attachment_number"]),
    pageStart: num(r["page_start"]),
    pageEnd: num(r["page_end"]),
    docType: txt(r["doc_type"]),
    dateFiled: txt(r["date_filed"]),
    content: typeof r["content"] === "string" ? (r["content"] as string) : "",
    rrfScore: num(r["rrf_score"]) ?? 0,
    vectorRank: num(r["vector_rank"]),
    keywordRank: num(r["keyword_rank"]),
    similarity: num(r["similarity"]),
    caseName: txt(r["case_name"]) ?? "Unknown matter",
    shortName: txt(r["short_name"]),
    docketNumber: txt(r["docket_number"]) ?? "",
    slug: txt(r["slug"]) ?? "",
    docTitle: txt(r["doc_title"]),
    entryLabel: txt(r["entry_label"]),
    s3Key: txt(r["s3_key"]),
    courtlistenerUrl: txt(r["courtlistener_url"]),
  };
}

// --- Embeddings + rerank (Voyage AI) -----------------------------------------

async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env["VOYAGE_API_KEY"];
  if (!key) return null;
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "voyage-law-2", input: [text], input_type: "query" }),
  });
  if (!res.ok) return null; // keyword leg alone still works
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  return data.data?.[0]?.embedding ?? null;
}

/**
 * Precision pass over fused candidates. Returns the top `topK` hits re-ordered
 * by rerank-2.5 relevance; falls back to the RRF order when unavailable.
 */
export async function rerankHits(query: string, hits: RagHit[], topK = 6): Promise<RagHit[]> {
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
    const data = (await res.json()) as { data?: { index: number }[] };
    const ranked = (data.data ?? [])
      .map((d) => hits[d.index])
      .filter((h): h is RagHit => Boolean(h));
    return ranked.length ? ranked : hits.slice(0, topK);
  } catch {
    return hits.slice(0, topK);
  }
}

// --- Retrieval ----------------------------------------------------------------

/** Hybrid RRF search over document chunks. Semantic leg is skipped silently
 *  when no Voyage key is configured; the keyword leg still runs. */
export async function hybridSearch(
  query: string,
  filters: RagFilters = {},
  matchCount = 8,
): Promise<RagHit[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await service().rpc("corpus_hybrid_match_chunks", {
    query_embedding: embedding ? JSON.stringify(embedding) : null,
    query_text: query,
    match_count: matchCount,
    filter_matter: filters.matterId ?? null,
    filter_doc_type: filters.docType ?? null,
    filter_entry: filters.entryNumber ?? null,
    filter_document: filters.documentId ?? null,
    filter_party: filters.party ?? null,
    filter_date_from: filters.dateFrom ?? null,
    filter_date_to: filters.dateTo ?? null,
    min_similarity: filters.minSimilarity ?? 0,
  });
  if (error) throw new Error(`hybrid search failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapHit);
}

/** Pinpoint read: one document's extracted chunks, optionally a page window. */
export async function readDocument(
  documentId: string,
  pageStart?: number,
  pageEnd?: number,
): Promise<DocumentRead | null> {
  const db = service();
  const [docRes, chunkRes] = await Promise.all([
    db.from("corpus_documents").select("*").eq("document_id", documentId).limit(1),
    db.rpc("corpus_read_document_chunks", {
      p_document_id: documentId,
      p_page_start: pageStart ?? null,
      p_page_end: pageEnd ?? null,
      p_max_chunks: 60,
    }),
  ]);
  const doc = (docRes.data?.[0] ?? null) as Record<string, unknown> | null;
  if (!doc) return null;

  let matter: Record<string, unknown> | null = null;
  const matterId = txt(doc["matter_id"]);
  if (matterId) {
    const { data } = await db
      .from("corpus_matters")
      .select("case_name, short_name, docket_number, court_name, slug")
      .eq("matter_id", matterId)
      .limit(1);
    matter = (data?.[0] ?? null) as Record<string, unknown> | null;
  }

  const chunks = ((chunkRes.data ?? []) as Record<string, unknown>[]).map((c) => ({
    chunkId: String(c["chunk_id"]),
    chunkIndex: num(c["chunk_index"]) ?? 0,
    pageStart: num(c["page_start"]),
    pageEnd: num(c["page_end"]),
    content: typeof c["content"] === "string" ? (c["content"] as string) : "",
  }));
  return { doc, matter, chunks };
}

// --- Citation helpers ---------------------------------------------------------

/** Bluebook-ish pinpoint: "In re Apple…, No. 5:22-md-03113, Dkt. 131 at 10". */
export function hitCitation(hit: RagHit): string {
  const label =
    hit.entryLabel ??
    (hit.entryNumber != null
      ? hit.attachmentNumber != null && hit.attachmentNumber > 0
        ? `${hit.entryNumber}-${hit.attachmentNumber}`
        : `${hit.entryNumber}`
      : "?");
  const pages =
    hit.pageStart != null
      ? `, at p. ${hit.pageStart}${hit.pageEnd != null && hit.pageEnd !== hit.pageStart ? `–${hit.pageEnd}` : ""}`
      : "";
  return `${hit.shortName || hit.caseName}, No. ${hit.docketNumber}, Dkt. ${label}${pages}`;
}

/** Best available link for a hit: the stored PDF (presigned S3 URL) so the
 *  document itself opens in a new tab; CourtListener provenance is only the
 *  fallback for metadata-only rows with no stored file. */
export async function hitPdfUrl(hit: {
  s3Key: string | null;
  courtlistenerUrl: string | null;
}): Promise<string | undefined> {
  if (hit.s3Key) {
    try {
      return await presignS3Get(MATTERS_BUCKET, hit.s3Key, 3600);
    } catch {
      /* fall through to provenance link */
    }
  }
  return hit.courtlistenerUrl ?? undefined;
}
