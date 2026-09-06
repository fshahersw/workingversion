// ============================================================================
// Server-only corpus v2 readers used by the research agent tools.
//
// Replaces the retired `registry` schema access layer: everything here reads
// the public bridge views (public.corpus_*) on the corpus project, using the
// same clean display labels and sort order as the Matters workspace.
// ============================================================================
import { corpusUrl } from "@/lib/corpus";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const sn = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function key(): string {
  const k = process.env["CORPUS_SERVICE_KEY"];
  if (!k) throw new Error("Corpus key not configured");
  return k;
}

async function rest(
  table: string,
  params: Record<string, string>,
  range?: [number, number],
  exactCount = false,
): Promise<{ rows: Row[]; total: number | null }> {
  const k = key();
  const headers: Record<string, string> = { apikey: k, Authorization: `Bearer ${k}` };
  if (range) headers["Range"] = `${range[0]}-${range[1]}`;
  if (exactCount) headers["Prefer"] = "count=exact";
  const res = await fetch(
    `${corpusUrl()}/rest/v1/${table}?${new URLSearchParams(params).toString()}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Corpus ${table}: ${res.status} ${await res.text()}`);
  const cr = res.headers.get("content-range");
  const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : null;
  return { rows: (await res.json()) as Row[], total: Number.isFinite(total) ? total : null };
}

async function count(table: string, params: Record<string, string>): Promise<number> {
  const { total } = await rest(table, { select: "*", ...params }, [0, 0], true);
  return total ?? 0;
}

const orFilter = (cols: string[], q: string) =>
  `(${cols.map((c) => `${c}.ilike.*${q.replace(/[(),*]/g, " ").trim()}*`).join(",")})`;

// --- Matters ----------------------------------------------------------------

export type AgentMatter = {
  matterId: string;
  slug: string;
  caseName: string;
  shortName: string;
  docketNumber: string;
  courtId: string;
  courtName: string | null;
  judge: string | null;
  status: string | null;
  stage: string | null;
  mdlNumber: string | null;
  nodeRole: string | null;
  dateFiled: string | null;
  dateTerminated: string | null;
  courtlistenerUrl: string | null;
};

const MATTER_COLS =
  "matter_id,slug,case_name,short_name,docket_number,court_id,court_name,judge,status,stage,node_role,mdl_number,date_filed,date_terminated,courtlistener_url";

function toMatter(m: Row): AgentMatter {
  return {
    matterId: s(m["matter_id"]),
    slug: s(m["slug"]),
    caseName: s(m["case_name"]),
    shortName: sn(m["short_name"]) ?? s(m["case_name"]),
    docketNumber: s(m["docket_number"]),
    courtId: s(m["court_id"]),
    courtName: sn(m["court_name"]),
    judge: sn(m["judge"]),
    status: sn(m["status"]),
    stage: sn(m["stage"]),
    mdlNumber: sn(m["mdl_number"]),
    nodeRole: sn(m["node_role"]),
    dateFiled: sn(m["date_filed"]),
    dateTerminated: sn(m["date_terminated"]),
    courtlistenerUrl: sn(m["courtlistener_url"]),
  };
}

export async function searchMattersV2(opts: {
  query?: string;
  court?: string;
  status?: string;
  limit?: number;
}): Promise<AgentMatter[]> {
  const params: Record<string, string> = { select: MATTER_COLS, order: "short_name.asc" };
  const q = opts.query?.trim();
  if (q) params["or"] = orFilter(["case_name", "short_name", "docket_number", "slug", "mdl_number"], q);
  if (opts.court?.trim()) params["court_id"] = `ilike.*${opts.court.trim()}*`;
  if (opts.status?.trim()) params["status"] = `ilike.*${opts.status.trim()}*`;
  const { rows } = await rest("corpus_matters", params, [0, Math.max(1, opts.limit ?? 8) - 1]);
  return rows.map(toMatter);
}

/** Accepts a matter_id (uuid) or a slug. */
export async function resolveMatter(idOrSlug: string): Promise<AgentMatter | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const { rows } = await rest(
    "corpus_matters",
    { select: MATTER_COLS, [isUuid ? "matter_id" : "slug"]: `eq.${idOrSlug}` },
    [0, 0],
  );
  return rows[0] ? toMatter(rows[0]) : null;
}

export type AgentMatterDetail = {
  matter: AgentMatter;
  entries: number;
  documents: number;
  withPdf: number;
  parties: { name: string; partyType: string | null }[];
  counsel: { attorney: string; firm: string | null; role: string | null }[];
};

export async function matterDetailV2(idOrSlug: string): Promise<AgentMatterDetail | null> {
  const matter = await resolveMatter(idOrSlug);
  if (!matter) return null;
  const eq = `eq.${matter.matterId}`;
  const [entries, documents, withPdf, parties, counsel] = await Promise.all([
    count("corpus_docket_entries", { matter_id: eq }),
    count("corpus_documents", { matter_id: eq }),
    count("corpus_documents", { matter_id: eq, s3_key: "not.is.null" }),
    rest("corpus_parties", { select: "name,party_type", matter_id: eq, order: "name.asc" }, [0, 199]),
    rest("corpus_counsel", { select: "attorney,firm,role", matter_id: eq, order: "attorney.asc" }, [0, 199]),
  ]);
  return {
    matter,
    entries,
    documents,
    withPdf,
    parties: parties.rows.map((p) => ({ name: s(p["name"]), partyType: sn(p["party_type"]) })),
    counsel: counsel.rows.map((c) => ({
      attorney: s(c["attorney"]),
      firm: sn(c["firm"]),
      role: sn(c["role"]),
    })),
  };
}

// --- Docket entries ---------------------------------------------------------

export type AgentEntry = {
  matterId: string;
  entryNumber: number | null;
  entryLabel: string;
  docketSource: string;
  dateFiled: string | null;
  description: string;
  entryType: string | null;
  hasPdf: boolean;
};

export async function searchEntriesV2(opts: {
  query: string;
  matterId?: string;
  limit?: number;
}): Promise<{ rows: AgentEntry[]; matters: Map<string, AgentMatter> }> {
  const params: Record<string, string> = {
    select:
      "matter_id,entry_number,entry_label,display_label_pretty,docket_source,date_filed,description,entry_type,has_pdf",
    order: "date_filed.desc.nullslast,sort_seq.desc.nullslast",
    description: `ilike.*${opts.query.trim()}*`,
  };
  if (opts.matterId) {
    const m = await resolveMatter(opts.matterId);
    if (!m) return { rows: [], matters: new Map() };
    params["matter_id"] = `eq.${m.matterId}`;
  }
  const { rows } = await rest("corpus_docket_entries", params, [0, Math.max(1, opts.limit ?? 10) - 1]);
  const entries = rows.map((r): AgentEntry => ({
    matterId: s(r["matter_id"]),
    entryNumber: num(r["entry_number"]),
    entryLabel: sn(r["display_label_pretty"]) ?? sn(r["entry_label"]) ?? s(r["entry_number"]),
    docketSource: s(r["docket_source"]) || "main",
    dateFiled: sn(r["date_filed"]),
    description: s(r["description"]),
    entryType: sn(r["entry_type"]),
    hasPdf: r["has_pdf"] === true,
  }));
  const ids = [...new Set(entries.map((e) => e.matterId))].filter(Boolean);
  const matters = new Map<string, AgentMatter>();
  if (ids.length) {
    const { rows: ms } = await rest(
      "corpus_matters",
      { select: MATTER_COLS, matter_id: `in.(${ids.join(",")})` },
      [0, ids.length - 1],
    );
    for (const m of ms) matters.set(s(m["matter_id"]), toMatter(m));
  }
  return { rows: entries, matters };
}

// --- Documents --------------------------------------------------------------

export type AgentDocument = {
  documentId: string;
  entryLabel: string;
  attachmentNumber: number | null;
  title: string;
  docType: string | null;
  pageCount: number | null;
  isSealed: boolean;
  textStatus: string;
  dateFiled: string | null;
  s3Key: string | null;
  courtlistenerUrl: string | null;
};

export async function listDocumentsV2(opts: {
  matterId: string;
  search?: string;
  limit?: number;
}): Promise<{ matter: AgentMatter | null; rows: AgentDocument[]; total: number }> {
  const matter = await resolveMatter(opts.matterId);
  if (!matter) return { matter: null, rows: [], total: 0 };
  const params: Record<string, string> = {
    select:
      "document_id,entry_label,display_label_pretty,attachment_number,title,doc_type,page_count,is_sealed,text_status,date_filed,s3_key,courtlistener_url",
    matter_id: `eq.${matter.matterId}`,
    order: "sort_seq.desc.nullslast,attachment_number.asc",
  };
  if (opts.search?.trim()) params["title"] = `ilike.*${opts.search.trim()}*`;
  const { rows, total } = await rest("corpus_documents", params, [0, Math.max(1, opts.limit ?? 10) - 1], true);
  return {
    matter,
    total: total ?? rows.length,
    rows: rows.map((r): AgentDocument => ({
      documentId: s(r["document_id"]),
      entryLabel: sn(r["display_label_pretty"]) ?? sn(r["entry_label"]) ?? "",
      attachmentNumber: num(r["attachment_number"]),
      title: s(r["title"]),
      docType: sn(r["doc_type"]),
      pageCount: num(r["page_count"]),
      isSealed: r["is_sealed"] === true,
      textStatus: s(r["text_status"]) || "no_pdf",
      dateFiled: sn(r["date_filed"]),
      s3Key: sn(r["s3_key"]),
      courtlistenerUrl: sn(r["courtlistener_url"]),
    })),
  };
}
