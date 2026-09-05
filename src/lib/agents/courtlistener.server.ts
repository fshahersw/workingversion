// ============================================================================
// CourtListener RECAP REST client (server-only) — free PACER archive.
//
// Plain HTTPS + Token auth (COURTLISTENER_API_TOKEN). Base
// https://www.courtlistener.com/api/rest/v4. This is the research agent's
// broad, FREE document-retrieval path: DocketBird gates full filing text to
// followed matters, but RECAP has the extracted text + PDF of nearly any
// already-archived federal filing. We use only the free archive (search +
// dockets + docket-entries + recap-documents); recap-fetch (paid PACER
// purchase, needs PACER creds) is intentionally NOT used.
// ============================================================================

const BASE = process.env["COURTLISTENER_API_BASE"] || "https://www.courtlistener.com/api/rest/v4";
const PDF_HOST = "https://storage.courtlistener.com";

export class CourtListenerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CourtListenerError";
  }
}

export function courtlistenerConfigured(): boolean {
  return !!process.env["COURTLISTENER_API_TOKEN"];
}

async function cl<T>(path: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  const token = process.env["COURTLISTENER_API_TOKEN"];
  if (!token) throw new CourtListenerError(401, "COURTLISTENER_API_TOKEN is not configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new CourtListenerError(0, `CourtListener request failed: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const detail = (json && typeof json === "object" && "detail" in json ? String((json as Record<string, unknown>)["detail"]) : "") || text.slice(0, 200);
    throw new CourtListenerError(res.status, `CourtListener HTTP ${res.status}: ${detail}`);
  }
  return (json ?? {}) as T;
}

const qp = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
};

// --- Search (GET /search/?type=r|rd|d) -------------------------------------

export type RecapSearchDoc = {
  id: number; // recap_document id
  documentNumber: string | null;
  description: string;
  snippet: string;
};

export type RecapSearchHit = {
  docketId: number | null;
  caseName: string;
  docketNumber: string | null;
  court: string | null;
  dateFiled: string | null;
  absoluteUrl: string | null;
  documents: RecapSearchDoc[];
  moreDocs: boolean;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Full-text RECAP search. type "r" = dockets w/ nested docs (default),
 *  "rd" = documents only, "d" = dockets only. Scope with court/date for signal. */
export async function recapSearch(
  query: string,
  opts?: {
    type?: "r" | "rd" | "d";
    court?: string;
    docketNumber?: string;
    filedAfter?: string;
    filedBefore?: string;
    orderBy?: string;
    signal?: AbortSignal;
  },
): Promise<RecapSearchHit[]> {
  const data = await cl<{ results?: Record<string, unknown>[] }>(
    `/search/${qp({
      q: query,
      type: opts?.type ?? "r",
      court: opts?.court,
      docket_number: opts?.docketNumber,
      filed_after: opts?.filedAfter,
      filed_before: opts?.filedBefore,
      order_by: opts?.orderBy,
    })}`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  const rows = Array.isArray(data.results) ? data.results : [];
  return rows.map((r) => {
    const docs = Array.isArray(r["recap_documents"]) ? (r["recap_documents"] as Record<string, unknown>[]) : [];
    return {
      docketId: num(r["docket_id"]),
      caseName: str(r["caseName"] ?? r["case_name"]),
      docketNumber: r["docketNumber"] != null ? str(r["docketNumber"]) : null,
      court: r["court"] != null ? str(r["court"]) : null,
      dateFiled: r["dateFiled"] != null ? str(r["dateFiled"]).slice(0, 10) : null,
      absoluteUrl: r["absolute_url"] != null ? `https://www.courtlistener.com${str(r["absolute_url"])}` : null,
      documents: docs.map((d) => ({
        id: Number(d["id"]),
        documentNumber: d["document_number"] != null ? str(d["document_number"]) : null,
        description: str(d["description"] ?? d["short_description"]),
        snippet: str(d["snippet"]),
      })),
      moreDocs: Boolean(r["more_docs"]),
    };
  });
}

// --- Docket entries (GET /docket-entries/?docket=) -------------------------

export type RecapDocMeta = {
  id: number;
  documentNumber: string | null;
  attachmentNumber: number | null;
  description: string;
  isAvailable: boolean;
  pageCount: number | null;
  pacerDocId: string | null;
};

export type DocketEntry = {
  id: number;
  entryNumber: number | null;
  dateFiled: string | null;
  description: string;
  documents: RecapDocMeta[];
};

function toDocMeta(d: Record<string, unknown>): RecapDocMeta {
  return {
    id: Number(d["id"]),
    documentNumber: d["document_number"] != null ? str(d["document_number"]) : null,
    attachmentNumber: d["attachment_number"] != null ? num(d["attachment_number"]) : null,
    description: str(d["description"]),
    isAvailable: Boolean(d["is_available"]),
    pageCount: num(d["page_count"]),
    pacerDocId: d["pacer_doc_id"] != null ? str(d["pacer_doc_id"]) : null,
  };
}

export async function getDocketEntries(
  docketId: number | string,
  opts?: { pageSize?: number; signal?: AbortSignal },
): Promise<DocketEntry[]> {
  const data = await cl<{ results?: Record<string, unknown>[] }>(
    `/docket-entries/${qp({ docket: String(docketId), page_size: opts?.pageSize ?? 100, order_by: "entry_number" })}`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  const rows = Array.isArray(data.results) ? data.results : [];
  return rows.map((r) => {
    const docs = Array.isArray(r["recap_documents"]) ? (r["recap_documents"] as Record<string, unknown>[]) : [];
    return {
      id: Number(r["id"]),
      entryNumber: num(r["entry_number"]),
      dateFiled: r["date_filed"] != null ? str(r["date_filed"]).slice(0, 10) : null,
      description: str(r["description"]),
      documents: docs.map(toDocMeta),
    };
  });
}

// --- Read a document (GET /recap-documents/{id}/) --------------------------

export type RecapDocument = {
  id: number;
  documentNumber: string | null;
  description: string;
  isAvailable: boolean;
  pageCount: number | null;
  ocrStatus: string | null;
  plainText: string;
  pdfUrl: string | null;
};

/** Full extracted text (+ PDF url) of one RECAP document. Free for archived
 *  docs; plain_text may be empty for scanned filings without clean OCR. */
export async function readRecapDocument(
  documentId: number | string,
  opts?: { signal?: AbortSignal },
): Promise<RecapDocument> {
  const d = await cl<Record<string, unknown>>(
    `/recap-documents/${encodeURIComponent(String(documentId))}/`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  const filepath = str(d["filepath_local"]);
  return {
    id: Number(d["id"] ?? documentId),
    documentNumber: d["document_number"] != null ? str(d["document_number"]) : null,
    description: str(d["description"]),
    isAvailable: Boolean(d["is_available"]),
    pageCount: num(d["page_count"]),
    ocrStatus: d["ocr_status"] != null ? str(d["ocr_status"]) : null,
    plainText: str(d["plain_text"]),
    pdfUrl: filepath ? `${PDF_HOST}/${filepath}` : null,
  };
}
