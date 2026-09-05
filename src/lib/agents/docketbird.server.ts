// ============================================================================
// DocketBird REST client (server-only) — federal docket & filings data.
//
// Plain HTTPS + Bearer token (DOCKETBIRD_API_KEY), no SDK. Base
// https://api.docketbird.com; every response is wrapped { status, data:{...} }.
// Powers the docket_research sub-agent. Full-text search works across all
// filings; reading a filing's text/metadata requires the firm to follow that
// case (own matters work; others return a "follow it" 403 the agent surfaces).
// ============================================================================

const BASE = process.env["DOCKETBIRD_API_BASE"] || "https://api.docketbird.com";

export class DocketBirdError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "DocketBirdError";
  }
}

export function docketbirdConfigured(): boolean {
  return !!process.env["DOCKETBIRD_API_KEY"];
}

export type DbFiling = {
  document_id: string;
  case_id: string;
  case_title: string;
  document_title: string;
  court_id: string;
  court_name: string;
  date_filed: string | null;
  snippets: string[];
  canonical_url: string;
};

export type DbCase = {
  id: string;
  title: string;
  court_id: string;
  case_number: string | null;
  date_filed: string | null;
  url?: string;
  pacer_case_id?: string;
  complaint_document_id?: string;
  complaint_status?: string;
};

async function db<T>(
  path: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal; method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const token = process.env["DOCKETBIRD_API_KEY"];
  if (!token) throw new DocketBirdError(401, "DOCKETBIRD_API_KEY is not configured.");

  const controller = new AbortController();
  // /graph/ask can take 10-25s; give POSTs a longer default ceiling.
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? (opts?.method === "POST" ? 45_000 : 30_000));
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (opts?.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts?.method ?? "GET",
      headers,
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new DocketBirdError(0, `DocketBird request failed: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  if (!res.ok || obj["status"] === "error") {
    const msg = (typeof obj["message"] === "string" && obj["message"]) || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new DocketBirdError(res.status, msg);
  }
  return (obj["data"] ?? {}) as T;
}

const qp = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
};

/** Full-text search across federal filings. Scope with case_id / court_id /
 *  date range for targeted results — never an unscoped nationwide sweep. */
export async function searchFilings(params: {
  q: string;
  caseId?: string;
  courtId?: string;
  filedAfter?: string;
  filedBefore?: string;
  size?: number;
  signal?: AbortSignal;
}): Promise<DbFiling[]> {
  const data = await db<{ documents?: DbFiling[] }>(
    `/documents/search${qp({
      q: params.q,
      case_id: params.caseId,
      court_id: params.courtId,
      filed_after: params.filedAfter,
      filed_before: params.filedBefore,
      size: params.size ?? 8,
    })}`,
    params.signal ? { signal: params.signal } : undefined,
  );
  return data.documents ?? [];
}

/** Full extracted text of a filing (own/followed cases only). */
export async function getFilingText(
  documentId: string,
  opts?: { signal?: AbortSignal },
): Promise<{ id: string; title: string; text: string }> {
  const data = await db<{ document?: { id?: string; title?: string; text?: string } }>(
    `/documents/${encodeURIComponent(documentId)}/text`,
    opts,
  );
  const d = data.document ?? {};
  return { id: String(d.id ?? documentId), title: String(d.title ?? ""), text: String(d.text ?? "") };
}

/** Case metadata by DocketBird case id, e.g. "txwd-6:2021-cv-00672". */
export async function getCase(caseId: string, opts?: { signal?: AbortSignal }): Promise<DbCase | null> {
  const data = await db<{ case?: DbCase }>(`/cases/${encodeURIComponent(caseId)}`, opts);
  return data.case ?? null;
}

// --- Case search (GET /cases/search) ---------------------------------------
// The missing primitive: resolve a case NAME or NUMBER to its case_id across
// the whole index (not just followed matters). Everything case-scoped starts
// here — get the id, then pull its docket sheet / filings / calendar.

export type DbCaseHit = {
  id: string;
  title: string;
  court_id: string;
  court_name: string;
  case_type: string;
  case_number: string | null;
  year_filed: string | null;
  date_filed: string | null;
  canonical_url: string;
  complaint_document_id: string | null;
  complaint_status: string | null;
};

export async function searchCases(params: {
  q: string;
  courtId?: string;
  filedAfter?: string;
  filedBefore?: string;
  size?: number;
  signal?: AbortSignal;
}): Promise<DbCaseHit[]> {
  const data = await db<{ cases?: DbCaseHit[] }>(
    `/cases/search${qp({
      q: params.q,
      court_id: params.courtId,
      filed_after: params.filedAfter,
      filed_before: params.filedBefore,
      size: params.size ?? 10,
    })}`,
    params.signal ? { signal: params.signal } : undefined,
  );
  return data.cases ?? [];
}

// --- Docket sheet (GET /documents?case_id=) --------------------------------
// The chronological list of docket entries for a case — filings and text-only
// minute entries. This is the instrument for "posture / latest activity /
// find the CMO", which full-text document SEARCH cannot answer.

export type DbDocketEntry = {
  id: string;
  case_id?: string;
  title: string;
  date_filed: string | null;
};

export async function getDocketSheet(
  caseId: string,
  sort: "chronological" | "recent" = "recent",
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DbDocketEntry[]> {
  // /documents has no server-side limit and streams the WHOLE docket, so a mega-
  // MDL can blow past the 29s gateway timeout. Default to a shorter ceiling here
  // so a huge docket fails fast and the caller can fall back to scoped search.
  const data = await db<unknown>(`/documents${qp({ case_id: caseId, sort })}`, {
    timeoutMs: opts?.timeoutMs ?? 15_000,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  const rows = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : (((data as Record<string, unknown>)?.["documents"] as Record<string, unknown>[]) ?? []);
  return rows.map((r) => ({
    id: String(r["id"] ?? ""),
    // Their schema spells the field "caset_id"; accept both.
    case_id: (r["case_id"] ?? r["caset_id"]) ? String(r["case_id"] ?? r["caset_id"]) : undefined,
    title: String(r["title"] ?? ""),
    date_filed: r["date_filed"] != null ? String(r["date_filed"]) : null,
  }));
}

// --- Case calendar (GET /calendar_entries?case_id=) ------------------------
// Deadlines, hearings, conferences from the firm's autocalendars. Richest for
// followed matters; may be empty for a case the firm does not track.

export type DbCalendarEntry = Record<string, unknown>;

export async function getCalendar(
  caseId: string,
  opts?: { signal?: AbortSignal },
): Promise<DbCalendarEntry[]> {
  const data = await db<unknown>(`/calendar_entries${qp({ case_id: caseId })}`, opts);
  if (Array.isArray(data)) return data as DbCalendarEntry[];
  const o = (data ?? {}) as Record<string, unknown>;
  const arr = o["calendar_entries"] ?? o["entries"];
  return Array.isArray(arr) ? (arr as DbCalendarEntry[]) : [];
}

/** Firm-wide AutoCalendar rollup (upcoming window). */
export type DbFirmCalendarEntry = {
  caseId: string;
  caseName: string;
  date: string;
  time: string | null;
  title: string;
  sourceDocumentId: string | null;
};

export async function getCompanyCalendar(
  days = 90,
  opts?: { signal?: AbortSignal },
): Promise<{
  entries: DbFirmCalendarEntry[];
  windowStart: string | null;
  windowEnd: string | null;
  lastUpdated: string | null;
}> {
  const data = await db<Record<string, unknown>>(
    `/calendar_entries${qp({ days: Math.min(Math.max(days, 1), 180) })}`,
    opts,
  );
  const raw = Array.isArray(data["calendar_entries"]) ? data["calendar_entries"] : [];
  const entries: DbFirmCalendarEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const caseId = String(r["case_id"] ?? "").trim();
    const date = String(r["date"] ?? "").slice(0, 10);
    if (!caseId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    entries.push({
      caseId,
      caseName: String(r["case_name"] ?? caseId),
      date,
      time: r["time"] != null && String(r["time"]).trim() ? String(r["time"]) : null,
      title: String(r["title"] ?? "").trim() || "Calendar entry",
      sourceDocumentId: r["source_document_id"] != null ? String(r["source_document_id"]) : null,
    });
  }
  return {
    entries,
    windowStart: data["window_start"] != null ? String(data["window_start"]) : null,
    windowEnd: data["window_end"] != null ? String(data["window_end"]) : null,
    lastUpdated: data["calendar_last_updated"] != null ? String(data["calendar_last_updated"]) : null,
  };
}

// --- Litigation graph (POST /graph/ask) ------------------------------------
// Natural-language questions over parties/attorneys/firms/judges. Federal civil
// only, ~30% coverage since 2025-07; num_records:0 means "not in the graph".

export type DbGraphResult = {
  records: Record<string, unknown>[];
  num_records: number;
  interpretation: string | null;
  truncated: boolean;
  coverage_note: string;
  message?: string;
};

export async function graphAsk(
  question: string,
  opts?: { signal?: AbortSignal },
): Promise<DbGraphResult> {
  const data = await db<Partial<DbGraphResult>>(`/graph/ask`, {
    method: "POST",
    body: { question },
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  return {
    records: Array.isArray(data.records) ? data.records : [],
    num_records: Number(data.num_records ?? 0),
    interpretation: data.interpretation ?? null,
    truncated: Boolean(data.truncated),
    coverage_note: String(data.coverage_note ?? ""),
    ...(data.message ? { message: data.message } : {}),
  };
}
