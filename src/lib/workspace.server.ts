// Server-only readers for the corpus v2 workspace. Queries the public-schema
// bridge views (public.corpus_*) on the corpus project with the service key.
import { corpusUrl, MATTERS_BUCKET } from "@/lib/corpus";
import type {
  DocumentQuery,
  DocumentsPage,
  EntriesPage,
  EntryQuery,
  MatterListItem,
  MatterWorkspace,
  PipelineRun,
  WorkspaceCounsel,
  WorkspaceDocument,
  WorkspaceEntry,
  WorkspaceParty,
} from "./workspace-types";

type Row = Record<string, unknown>;

function key(): string {
  const k = process.env["CORPUS_SERVICE_KEY"];
  if (!k) throw new Error("Corpus key not configured");
  return k;
}

async function request(
  table: string,
  params: Record<string, string>,
  range?: [number, number],
  exactCount = false,
): Promise<{ rows: Row[]; total: number | null }> {
  const k = key();
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    apikey: k,
    Authorization: `Bearer ${k}`,
  };
  if (range) headers["Range"] = `${range[0]}-${range[1]}`;
  if (exactCount) headers["Prefer"] = "count=exact";
  const res = await fetch(`${corpusUrl()}/rest/v1/${table}?${qs}`, { headers });
  if (!res.ok) throw new Error(`Corpus ${table}: ${res.status} ${await res.text()}`);
  const cr = res.headers.get("content-range");
  const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : null;
  return { rows: (await res.json()) as Row[], total: Number.isFinite(total) ? total : null };
}

async function selectAll(table: string, params: Record<string, string>): Promise<Row[]> {
  const PAGE = 1000;
  const first = await request(table, params, [0, PAGE - 1], true);
  const total = first.total ?? first.rows.length;
  if (total <= PAGE) return first.rows;
  const pages: Promise<{ rows: Row[] }>[] = [];
  for (let off = PAGE; off < total; off += PAGE) {
    pages.push(request(table, params, [off, off + PAGE - 1]));
  }
  const rest = await Promise.all(pages);
  return first.rows.concat(...rest.map((r) => r.rows));
}

async function countOf(table: string, params: Record<string, string>): Promise<number> {
  const { total } = await request(table, { select: "*", ...params }, [0, 0], true);
  return total ?? 0;
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const sn = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown): boolean => v === true;

function toMatterItem(m: Row, counts: { entries: number; documents: number; withPdf: number }): MatterListItem {
  return {
    matterId: s(m["matter_id"]),
    slug: s(m["slug"]),
    shortName: sn(m["short_name"]) ?? s(m["case_name"]),
    caseName: s(m["case_name"]),
    docketNumber: s(m["docket_number"]),
    courtId: s(m["court_id"]),
    courtName: sn(m["court_name"]),
    judge: sn(m["judge"]),
    status: sn(m["status"]),
    stage: sn(m["stage"]),
    mdlNumber: sn(m["mdl_number"]),
    pipelineStage: s(m["pipeline_stage"]) || "new",
    verifiedAt: sn(m["verified_at"]),
    ...counts,
  };
}

async function matterCounts(matterId: string) {
  const eq = `eq.${matterId}`;
  const [entries, documents, withPdf] = await Promise.all([
    countOf("corpus_docket_entries", { matter_id: eq }),
    countOf("corpus_documents", { matter_id: eq }),
    countOf("corpus_documents", { matter_id: eq, s3_key: "not.is.null" }),
  ]);
  return { entries, documents, withPdf };
}

export async function listMatters(): Promise<MatterListItem[]> {
  const rows = await selectAll("corpus_matters", {
    select: "matter_id,slug,short_name,case_name,docket_number,court_id,court_name,judge,status,stage,mdl_number,pipeline_stage,verified_at",
    order: "short_name.asc",
  });
  return Promise.all(rows.map(async (m) => toMatterItem(m, await matterCounts(s(m["matter_id"])))));
}

export async function loadWorkspace(slug: string): Promise<MatterWorkspace | null> {
  const { rows } = await request("corpus_matters", {
    select: "*",
    slug: `eq.${slug}`,
  }, [0, 0]);
  const m = rows[0];
  if (!m) return null;
  const matterId = s(m["matter_id"]);
  const eq = `eq.${matterId}`;

  const [counts, parties, counsel, docTypes, firstDate, lastDate] = await Promise.all([
    matterCounts(matterId),
    selectAll("corpus_parties", { select: "party_id,name,party_type", matter_id: eq, order: "name.asc" }),
    selectAll("corpus_counsel", { select: "counsel_id,attorney,firm,role,party_name", matter_id: eq, order: "attorney.asc" }),
    selectAll("corpus_documents", { select: "doc_type", matter_id: eq }),
    request("corpus_docket_entries", { select: "date_filed", matter_id: eq, date_filed: "not.is.null", order: "date_filed.asc" }, [0, 0]),
    request("corpus_docket_entries", { select: "date_filed", matter_id: eq, date_filed: "not.is.null", order: "date_filed.desc" }, [0, 0]),
  ]);

  const facetMap = new Map<string, number>();
  for (const d of docTypes) {
    const t = s(d["doc_type"]) || "other";
    facetMap.set(t, (facetMap.get(t) ?? 0) + 1);
  }

  return {
    matter: toMatterItem(m, counts),
    parties: parties.map((p): WorkspaceParty => ({
      id: s(p["party_id"]),
      name: s(p["name"]),
      partyType: sn(p["party_type"]),
    })),
    counsel: counsel.map((c): WorkspaceCounsel => ({
      id: s(c["counsel_id"]),
      attorney: s(c["attorney"]),
      firm: sn(c["firm"]),
      role: sn(c["role"]),
      partyName: sn(c["party_name"]),
    })),
    typeFacets: [...facetMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    dateRange: {
      first: sn(firstDate.rows[0]?.["date_filed"]),
      last: sn(lastDate.rows[0]?.["date_filed"]),
    },
  };
}

const ENTRY_SORT: Record<string, string> = {
  "entry-desc": "docket_source.asc,sort_seq.desc.nullslast,entry_number.desc",
  "entry-asc": "docket_source.asc,sort_seq.asc.nullslast,entry_number.asc",
  "date-desc": "date_filed.desc.nullslast,sort_seq.desc.nullslast",
  "date-asc": "date_filed.asc.nullslast,sort_seq.asc.nullslast",
};

const ENTRY_COLS =
  "docket_entry_id,entry_number,entry_label,display_label_pretty,docket_source,date_filed,description,entry_type,page_count,document_count,has_pdf";
const DOC_COLS =
  "document_id,entry_number,entry_label,display_label_pretty,docket_source,attachment_number,title,doc_type,byte_count,page_count,is_sealed,text_status,s3_key";

const source = (v: unknown): "main" | "jpml" => (v === "jpml" ? "jpml" : "main");

export async function loadEntries(q: EntryQuery): Promise<EntriesPage> {
  const matterId = await matterIdFor(q.slug);
  const params: Record<string, string> = {
    select: ENTRY_COLS,
    matter_id: `eq.${matterId}`,
    order: ENTRY_SORT[q.sort ?? "entry-desc"],
  };
  if (q.search?.trim()) params["description"] = `ilike.*${q.search.trim()}*`;
  if (q.types?.length) params["entry_type"] = `in.(${q.types.join(",")})`;
  if (q.onlyWithPdf) params["has_pdf"] = "eq.true";
  if (q.docket) params["docket_source"] = `eq.${q.docket}`;
  const { rows, total } = await request(params && "corpus_docket_entries", params,
    [q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50) - 1], true);
  return {
    total: total ?? rows.length,
    rows: rows.map((r): WorkspaceEntry => ({
      id: s(r["docket_entry_id"]),
      entryNumber: num(r["entry_number"]) ?? 0,
      entryLabel: sn(r["display_label_pretty"]) ?? sn(r["entry_label"]) ?? s(r["entry_number"]),
      docketSource: source(r["docket_source"]),
      dateFiled: sn(r["date_filed"]),
      description: s(r["description"]),
      entryType: sn(r["entry_type"]),
      pageCount: num(r["page_count"]),
      documentCount: num(r["document_count"]) ?? 0,
      hasPdf: bool(r["has_pdf"]),
    })),
  };
}

export async function loadDocuments(q: DocumentQuery): Promise<DocumentsPage> {
  const matterId = await matterIdFor(q.slug);
  const params: Record<string, string> = {
    select: DOC_COLS,
    matter_id: `eq.${matterId}`,
    order:
      q.sort === "entry-asc"
        ? "docket_source.asc,sort_seq.asc.nullslast,attachment_number.asc"
        : "docket_source.asc,sort_seq.desc.nullslast,attachment_number.asc",
  };
  if (q.search?.trim()) params["title"] = `ilike.*${q.search.trim()}*`;
  if (q.types?.length) params["doc_type"] = `in.(${q.types.join(",")})`;
  if (q.onlyWithPdf) params["s3_key"] = "not.is.null";
  if (q.docket) params["docket_source"] = `eq.${q.docket}`;
  const { rows, total } = await request("corpus_documents", params,
    [q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50) - 1], true);
  return {
    total: total ?? rows.length,
    rows: rows.map(mapDocument),
  };
}

function mapDocument(r: Record<string, unknown>): WorkspaceDocument {
  return {
    id: s(r["document_id"]),
    entryNumber: num(r["entry_number"]),
    entryLabel: sn(r["display_label_pretty"]) ?? sn(r["entry_label"]) ?? s(r["entry_number"]),
    docketSource: source(r["docket_source"]),
    attachmentNumber: num(r["attachment_number"]) ?? 0,
    title: s(r["title"]),
    docType: sn(r["doc_type"]),
    byteCount: num(r["byte_count"]),
    pageCount: num(r["page_count"]),
    hasPdf: !!sn(r["s3_key"]),
    isSealed: bool(r["is_sealed"]),
    textStatus: s(r["text_status"]) || "no_pdf",
  };
}

/**
 * Documents attached to one docket entry (for the inline viewer).
 * Keyed by docket_entry_id: entry numbers repeat across docket sources
 * (main #1 and JPML #1 both exist) since the v2.4 docket-source normalization.
 */
export async function loadEntryDocuments(slug: string, entryId: string): Promise<WorkspaceDocument[]> {
  const matterId = await matterIdFor(slug);
  const rows = await selectAll("corpus_documents", {
    select: DOC_COLS,
    matter_id: `eq.${matterId}`,
    docket_entry_id: `eq.${entryId}`,
    order: "attachment_number.asc",
  });
  return rows.map(mapDocument);
}


export async function documentViewUrl(documentId: string): Promise<{ url: string | null; error?: string }> {
  const { rows } = await request("corpus_documents", {
    select: "s3_key",
    document_id: `eq.${documentId}`,
  }, [0, 0]);
  const key0 = sn(rows[0]?.["s3_key"]);
  if (!key0) return { url: null, error: "No PDF stored for this document yet" };
  try {
    const { presignS3Get } = await import("./s3.server");
    return { url: await presignS3Get(MATTERS_BUCKET, key0, 1800) };
  } catch (e) {
    return { url: null, error: e instanceof Error ? e.message : "Presign failed" };
  }
}

/** Presign PUT URLs for browser-direct uploads into <slug>/incoming/. */
export async function uploadUrls(
  slug: string,
  files: { name: string; size: number }[],
  namespace?: string,
): Promise<{ name: string; key: string; url: string }[]> {
  const safe = (n: string) => n.replace(/[^A-Za-z0-9._()\- ]/g, "_").replace(/^\/+/, "");
  const ns = namespace?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  const prefix = `${slug}/incoming/${ns ? `${ns}/` : ""}`;
  const { presignS3Put } = await import("./s3.server");
  const out = [];
  for (const f of files.slice(0, 1000)) {
    const key0 = `${prefix}${Date.now()}-${safe(f.name)}`;
    out.push({ name: f.name, key: key0, url: await presignS3Put(MATTERS_BUCKET, key0, 3600) });
  }
  return out;
}

export async function loadPipelineRuns(limit = 20): Promise<PipelineRun[]> {
  const rows = await selectAll("corpus_ingest_runs", {
    select: "run_id,slug,stage,status,detail,started_at,finished_at",
    order: "started_at.desc",
  });
  return rows.slice(0, limit).map((r): PipelineRun => ({
    id: s(r["run_id"]),
    slug: s(r["slug"]),
    stage: s(r["stage"]),
    status: s(r["status"]),
    startedAt: sn(r["started_at"]),
    finishedAt: sn(r["finished_at"]),
    detail: r["detail"] == null ? null : JSON.stringify(r["detail"]),
  }));
}

const matterIdCache = new Map<string, { id: string; at: number }>();

async function matterIdFor(slug: string): Promise<string> {
  const hit = matterIdCache.get(slug);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const { rows } = await request("corpus_matters", { select: "matter_id", slug: `eq.${slug}` }, [0, 0]);
  const id = sn(rows[0]?.["matter_id"]);
  if (!id) throw new Error(`Unknown matter: ${slug}`);
  matterIdCache.set(slug, { id, at: Date.now() });
  return id;
}
