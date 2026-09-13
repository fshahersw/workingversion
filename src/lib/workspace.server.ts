// Server-only readers for the matters workspace. Reads the firm's Aurora corpus
// (corpus.* schema in the sw-kb-kb / kb cluster) through the RDS Data API; no
// Supabase. Dockets carry a scope (federal transferee, JPML, member case, state,
// appellate); files are grouped into a docket-entry ledger. PDFs are presigned
// from the matters corpus bucket.
//
// The Data API costs ~1s per round trip regardless of query cost, so every
// reader issues as few statements as possible and runs count + page in parallel.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SqlParameter } from "@aws-sdk/client-rds-data";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { courtInfo } from "@/lib/courts";
import { kbConfigured, listCast, listParam, param, queryJson } from "@/lib/kb/aurora.server";

import {
  DOCKET_SCOPES,
  type DocketScope,
  type DocumentQuery,
  type DocumentsPage,
  type EntriesPage,
  type EntryQuery,
  type LedgerFilter,
  type MatterListItem,
  type MatterWorkspace,
  type PipelineRun,
  type ScopeCounts,
  type WorkspaceDocket,
  type WorkspaceDocument,
} from "./workspace-types";

const CORPUS_BUCKET =
  process.env["MATTERS_CORPUS_BUCKET"] ||
  process.env["CORPUS_BUCKET"] ||
  "sw-matters-corpus-475976462949";
const REGION = process.env["AWS_REGION"] || "us-east-1";

let _s3: S3Client | undefined;
function s3(): S3Client {
  // WHEN_REQUIRED keeps the SDK from injecting a default CRC32 checksum that a
  // browser presigned PUT cannot supply (see src/lib/data/s3.server.ts).
  return (_s3 ??= new S3Client({ region: REGION, requestChecksumCalculation: "WHEN_REQUIRED" }));
}

function ensure(): void {
  if (!kbConfigured()) {
    throw new Error(
      "Corpus DB is not configured (set KB_CLUSTER_ARN, KB_SECRET_ARN, KB_DATABASE).",
    );
  }
}

const num = (v: unknown): number => (v == null ? 0 : Number(v)) || 0;
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v);
  // Data API returns timestamps as "YYYY-MM-DD HH:MM:SS.ffffff"; normalise to ISO.
  return s.includes(" ") && !s.includes("T") ? `${s.replace(" ", "T")}Z` : s;
};
const scopeOf = (v: unknown): DocketScope =>
  (DOCKET_SCOPES as string[]).includes(String(v)) ? (String(v) as DocketScope) : "federal";

function parseScopeCounts(raw: unknown): ScopeCounts {
  const empty = (): ScopeCounts =>
    Object.fromEntries(DOCKET_SCOPES.map((s) => [s, { dockets: 0, files: 0 }])) as ScopeCounts;
  const out = empty();
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(
    obj as Record<string, { dockets?: unknown; files?: unknown }>,
  )) {
    if ((DOCKET_SCOPES as string[]).includes(k)) {
      out[k as DocketScope] = { dockets: num(v?.dockets), files: num(v?.files) };
    }
  }
  return out;
}

// --- matters ------------------------------------------------------------------

type MatterRow = {
  slug: string;
  title: string | null;
  mdlNumber: string | null;
  courtId: string | null;
  docketNumber: string | null;
  entries: number;
  documents: number;
  withPdf: number;
  sealed: number;
  scopeCounts: unknown;
  lastSyncedAt: string | null;
};

// The lead docket is corpus.matters.lead_case_id when set, else the first
// federal docket flagged is_lead, else the first federal docket.
const MATTER_SELECT = `
  SELECT m.matter_id AS "slug", m.title AS "title", m.mdl_number AS "mdlNumber",
    ld.court_id AS "courtId", ld.docket_number AS "docketNumber",
    agg.entries AS "entries", agg.documents AS "documents", agg.with_pdf AS "withPdf", agg.sealed AS "sealed",
    sc.counts AS "scopeCounts",
    (SELECT max(d.last_synced_at) FROM corpus.dockets d WHERE d.matter_id = m.matter_id) AS "lastSyncedAt"
  FROM corpus.matters m
  LEFT JOIN LATERAL (
    SELECT d.court_id, d.docket_number FROM corpus.dockets d
    WHERE d.matter_id = m.matter_id
    ORDER BY (d.docket_id = m.lead_case_id) DESC,
             CASE d.scope WHEN 'federal' THEN 0 WHEN 'jpml' THEN 1 WHEN 'state' THEN 2 ELSE 3 END,
             d.is_lead DESC
    LIMIT 1
  ) ld ON true
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT (f.docket_id, f.entry_number)) AS entries,
           count(*) AS documents,
           count(*) FILTER (WHERE f.s3_key IS NOT NULL) AS with_pdf,
           count(*) FILTER (WHERE f.is_sealed) AS sealed
    FROM corpus.docket_files f WHERE f.matter_id = m.matter_id
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(s.scope, jsonb_build_object('dockets', s.dockets, 'files', s.files)) AS counts
    FROM (
      SELECT d.scope, count(DISTINCT d.docket_id) AS dockets, count(f.file_id) AS files
      FROM corpus.dockets d LEFT JOIN corpus.docket_files f ON f.docket_id = d.docket_id
      WHERE d.matter_id = m.matter_id GROUP BY d.scope
    ) s
  ) sc ON true
`;

function toMatterItem(r: MatterRow): MatterListItem {
  const name = r.title ?? r.slug;
  const court = courtInfo(r.courtId);
  return {
    matterId: r.slug,
    slug: r.slug,
    shortName: name.replace(/^In re:?\s*/i, ""),
    caseName: name,
    mdlNumber: r.mdlNumber,
    docketNumber: r.docketNumber ?? "",
    courtId: r.courtId ?? "",
    courtName: r.courtId ? court.label : null,
    judge: null,
    entries: num(r.entries),
    documents: num(r.documents),
    withPdf: num(r.withPdf),
    sealed: num(r.sealed),
    scopeCounts: parseScopeCounts(r.scopeCounts),
    lastSyncedAt: iso(r.lastSyncedAt),
  };
}

export async function listMatters(): Promise<MatterListItem[]> {
  ensure();
  const rows = await queryJson<MatterRow>(`${MATTER_SELECT} ORDER BY m.title`);
  return rows.map(toMatterItem);
}

type DocketRow = {
  docketId: string;
  scope: string;
  courtId: string | null;
  docketNumber: string | null;
  title: string | null;
  isLead: boolean | null;
  entryCount: number | null;
  filesPresent: number | null;
  pdfAvailable: number | null;
  sealedCount: number | null;
  missingCount: number | null;
  completionPct: number | string | null;
  followed: boolean | null;
  lastSyncedAt: string | null;
};

function toDocket(r: DocketRow): WorkspaceDocket {
  return {
    docketId: r.docketId,
    scope: scopeOf(r.scope),
    courtId: r.courtId ?? "",
    docketNumber: r.docketNumber ?? "",
    title: r.title,
    isLead: !!r.isLead,
    entryCount: num(r.entryCount),
    filesPresent: num(r.filesPresent),
    pdfAvailable: num(r.pdfAvailable),
    sealedCount: num(r.sealedCount),
    missingCount: num(r.missingCount),
    completionPct: r.completionPct == null ? null : Number(r.completionPct),
    followed: !!r.followed,
    lastSyncedAt: iso(r.lastSyncedAt),
  };
}

export async function loadWorkspace(slug: string): Promise<MatterWorkspace | null> {
  ensure();
  const [matterRows, docketRows, facets, range] = await Promise.all([
    queryJson<MatterRow>(`${MATTER_SELECT} WHERE m.matter_id = :slug LIMIT 1`, [
      param("slug", slug),
    ]),
    queryJson<DocketRow>(
      `SELECT d.docket_id AS "docketId", d.scope AS "scope", d.court_id AS "courtId",
              d.docket_number AS "docketNumber", d.title AS "title", d.is_lead AS "isLead",
              d.entry_count AS "entryCount",
              (SELECT count(*) FROM corpus.docket_files f WHERE f.docket_id = d.docket_id) AS "filesPresent",
              (SELECT count(*) FROM corpus.docket_files f WHERE f.docket_id = d.docket_id AND f.s3_key IS NOT NULL) AS "pdfAvailable",
              d.sealed_count AS "sealedCount", d.missing_count AS "missingCount",
              d.completion_pct AS "completionPct", d.followed_in_db AS "followed", d.last_synced_at AS "lastSyncedAt"
       FROM corpus.dockets d
       WHERE d.matter_id = :slug
       ORDER BY CASE d.scope WHEN 'federal' THEN 0 WHEN 'jpml' THEN 1 WHEN 'appellate' THEN 2 WHEN 'state' THEN 3 ELSE 4 END,
                d.is_lead DESC, "filesPresent" DESC, d.docket_number`,
      [param("slug", slug)],
    ),
    queryJson<{ type: string; count: number }>(
      `SELECT COALESCE(doc_type, 'other') AS "type", count(*) AS "count"
       FROM corpus.docket_files WHERE matter_id = :slug
       GROUP BY COALESCE(doc_type, 'other') ORDER BY "count" DESC`,
      [param("slug", slug)],
    ),
    queryJson<{ first: string | null; last: string | null }>(
      `SELECT min(date_filed) AS "first", max(date_filed) AS "last"
       FROM corpus.docket_files WHERE matter_id = :slug AND date_filed IS NOT NULL`,
      [param("slug", slug)],
    ),
  ]);
  const m = matterRows[0];
  if (!m) return null;

  return {
    matter: toMatterItem(m),
    dockets: docketRows.map(toDocket),
    parties: [], // Parties / counsel are not modeled in Aurora yet (CourtListener scrape pending).
    counsel: [],
    typeFacets: facets.map((f) => ({ type: f.type, count: num(f.count) })),
    dateRange: { first: range[0]?.first ?? null, last: range[0]?.last ?? null },
  };
}

// --- ledger + documents ------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildFilters(q: LedgerFilter): { where: string; params: SqlParameter[] } {
  const where = ["f.matter_id = :slug"];
  const params: SqlParameter[] = [param("slug", q.slug)];
  const search = q.search?.trim();
  if (search) {
    params.push(param("q", search));
    if (/^\d{1,6}$/.test(search)) {
      params.push(param("qnum", Number(search)));
      where.push("(f.title ILIKE '%' || :q || '%' OR f.entry_number = :qnum)");
    } else {
      where.push("f.title ILIKE '%' || :q || '%'");
    }
  }
  if (q.types?.length) {
    params.push(listParam("types", q.types));
    where.push(`COALESCE(f.doc_type, 'other') = ANY(${listCast("types", "text")})`);
  }
  if (q.docketId) {
    params.push(param("docketId", q.docketId));
    where.push("d.docket_id = :docketId");
  } else if (q.scope && (DOCKET_SCOPES as string[]).includes(q.scope)) {
    params.push(param("scope", q.scope));
    where.push("d.scope = :scope");
  }
  if (q.dateFrom && DATE_RE.test(q.dateFrom)) {
    params.push(param("dateFrom", q.dateFrom));
    where.push("f.date_filed >= CAST(:dateFrom AS date)");
  }
  if (q.dateTo && DATE_RE.test(q.dateTo)) {
    params.push(param("dateTo", q.dateTo));
    where.push("f.date_filed <= CAST(:dateTo AS date)");
  }
  if (q.onlyWithPdf) where.push("f.s3_key IS NOT NULL");
  if (q.hideSealed) where.push("COALESCE(f.is_sealed, false) = false");
  return { where: where.join(" AND "), params };
}

// Ledger rows are (docket, entry) groups; keep the docket order stable inside
// a date so JPML and transferee entries filed the same day do not interleave.
const ENTRY_ORDER: Record<string, string> = {
  "date-desc": `min(f.date_filed) DESC NULLS LAST, d.docket_id, f.entry_number DESC NULLS LAST`,
  "date-asc": `min(f.date_filed) ASC NULLS LAST, d.docket_id, f.entry_number ASC NULLS LAST`,
  "entry-desc": `d.docket_id, f.entry_number DESC NULLS LAST`,
  "entry-asc": `d.docket_id, f.entry_number ASC NULLS LAST`,
};

const DOC_ORDER: Record<string, string> = {
  "date-desc": `f.date_filed DESC NULLS LAST, d.docket_id, f.entry_number DESC NULLS LAST, f.attachment_number ASC`,
  "date-asc": `f.date_filed ASC NULLS LAST, d.docket_id, f.entry_number ASC NULLS LAST, f.attachment_number ASC`,
  "entry-desc": `d.docket_id, f.entry_number DESC NULLS LAST, f.attachment_number ASC`,
  "entry-asc": `d.docket_id, f.entry_number ASC NULLS LAST, f.attachment_number ASC`,
};

type EntryRow = {
  id: string;
  docketId: string;
  scope: string;
  courtId: string | null;
  docketNumber: string | null;
  entryNumber: number | null;
  dateFiled: string | null;
  dateApprox: boolean | null;
  description: string | null;
  entryType: string | null;
  pageCount: number | null;
  documentCount: number;
  pdfCount: number;
  sealedCount: number;
};

export async function loadEntries(q: EntryQuery): Promise<EntriesPage> {
  ensure();
  const { where, params } = buildFilters(q);
  const order = ENTRY_ORDER[q.sort ?? "date-desc"] ?? ENTRY_ORDER["date-desc"];
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const groupBy = `d.docket_id, d.scope, d.court_id, d.docket_number, f.entry_number`;
  const [rows, totals] = await Promise.all([
    queryJson<EntryRow>(
      `SELECT d.docket_id || ':' || COALESCE(f.entry_number, 0) AS "id",
              d.docket_id AS "docketId", d.scope AS "scope", d.court_id AS "courtId", d.docket_number AS "docketNumber",
              f.entry_number AS "entryNumber",
              min(f.date_filed) AS "dateFiled",
              bool_and(f.source = 'courtlistener_recap') AS "dateApprox",
              (array_agg(f.title ORDER BY COALESCE(f.attachment_number, 0)))[1] AS "description",
              (array_agg(f.doc_type ORDER BY COALESCE(f.attachment_number, 0)))[1] AS "entryType",
              sum(f.page_count) AS "pageCount",
              count(*) AS "documentCount",
              count(*) FILTER (WHERE f.s3_key IS NOT NULL) AS "pdfCount",
              count(*) FILTER (WHERE f.is_sealed) AS "sealedCount"
       FROM corpus.docket_files f JOIN corpus.dockets d ON d.docket_id = f.docket_id
       WHERE ${where}
       GROUP BY ${groupBy}
       ORDER BY ${order}
       LIMIT :lim OFFSET :off`,
      [...params, param("lim", limit), param("off", offset)],
    ),
    queryJson<{ count: number }>(
      `SELECT count(*) AS "count" FROM (
         SELECT 1 FROM corpus.docket_files f JOIN corpus.dockets d ON d.docket_id = f.docket_id
         WHERE ${where} GROUP BY ${groupBy}
       ) t`,
      params,
    ),
  ]);
  return {
    total: num(totals[0]?.count),
    rows: rows.map((r) => ({
      id: r.id,
      docketId: r.docketId,
      scope: scopeOf(r.scope),
      courtId: r.courtId ?? "",
      docketNumber: r.docketNumber ?? "",
      entryNumber: num(r.entryNumber),
      entryLabel: r.entryNumber == null ? "—" : String(r.entryNumber),
      dateFiled: r.dateFiled ?? null,
      dateApprox: !!r.dateApprox,
      description: r.description ?? "",
      entryType: r.entryType ?? null,
      pageCount: numOrNull(r.pageCount),
      documentCount: num(r.documentCount),
      pdfCount: num(r.pdfCount),
      sealedCount: num(r.sealedCount),
      hasPdf: num(r.pdfCount) > 0,
    })),
  };
}

const DOC_SELECT = `
  SELECT f.file_id AS "id", d.docket_id AS "docketId", d.scope AS "scope", d.court_id AS "courtId",
         d.docket_number AS "docketNumber", f.entry_number AS "entryNumber",
         COALESCE(f.attachment_number, 0) AS "attachmentNumber", f.title AS "title", f.doc_type AS "docType",
         f.date_filed AS "dateFiled", (f.source = 'courtlistener_recap') AS "dateApprox",
         f.byte_count AS "byteCount", f.page_count AS "pageCount", (f.s3_key IS NOT NULL) AS "hasPdf",
         COALESCE(f.is_sealed, false) AS "isSealed", f.source AS "source"
  FROM corpus.docket_files f JOIN corpus.dockets d ON d.docket_id = f.docket_id
`;

type DocRow = {
  id: string;
  docketId: string;
  scope: string;
  courtId: string | null;
  docketNumber: string | null;
  entryNumber: number | null;
  attachmentNumber: number;
  title: string | null;
  docType: string | null;
  dateFiled: string | null;
  dateApprox: boolean | null;
  byteCount: number | null;
  pageCount: number | null;
  hasPdf: boolean;
  isSealed: boolean;
  source: string | null;
};

function toDocument(r: DocRow): WorkspaceDocument {
  return {
    id: r.id,
    docketId: r.docketId,
    scope: scopeOf(r.scope),
    courtId: r.courtId ?? "",
    docketNumber: r.docketNumber ?? "",
    entryNumber: r.entryNumber == null ? null : Number(r.entryNumber),
    entryLabel: r.entryNumber == null ? "—" : String(r.entryNumber),
    attachmentNumber: num(r.attachmentNumber),
    title: r.title ?? "",
    docType: r.docType ?? null,
    dateFiled: r.dateFiled ?? null,
    dateApprox: !!r.dateApprox,
    byteCount: numOrNull(r.byteCount),
    pageCount: numOrNull(r.pageCount),
    hasPdf: !!r.hasPdf,
    isSealed: !!r.isSealed,
    source: r.source ?? null,
  };
}

export async function loadDocuments(q: DocumentQuery): Promise<DocumentsPage> {
  ensure();
  const { where, params } = buildFilters(q);
  const order = DOC_ORDER[q.sort ?? "date-desc"] ?? DOC_ORDER["date-desc"];
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const [rows, totals] = await Promise.all([
    queryJson<DocRow>(`${DOC_SELECT} WHERE ${where} ORDER BY ${order} LIMIT :lim OFFSET :off`, [
      ...params,
      param("lim", limit),
      param("off", offset),
    ]),
    queryJson<{ count: number }>(
      `SELECT count(*) AS "count" FROM corpus.docket_files f JOIN corpus.dockets d ON d.docket_id = f.docket_id WHERE ${where}`,
      params,
    ),
  ]);
  return { total: num(totals[0]?.count), rows: rows.map(toDocument) };
}

/** Documents attached to one ledger entry (id = "<docket_id>:<entry_number>"). */
export async function loadEntryDocuments(
  slug: string,
  entryId: string,
): Promise<WorkspaceDocument[]> {
  ensure();
  const sep = entryId.lastIndexOf(":");
  if (sep < 0) return [];
  const docketId = entryId.slice(0, sep);
  const entryNumber = Number(entryId.slice(sep + 1));
  const rows = await queryJson<DocRow>(
    `${DOC_SELECT} WHERE f.matter_id = :slug AND f.docket_id = :docketId AND COALESCE(f.entry_number, 0) = :entry
     ORDER BY COALESCE(f.attachment_number, 0) ASC`,
    [
      param("slug", slug),
      param("docketId", docketId),
      param("entry", Number.isFinite(entryNumber) ? entryNumber : 0),
    ],
  );
  return rows.map(toDocument);
}

export async function documentViewUrl(
  documentId: string,
): Promise<{ url: string | null; error?: string }> {
  ensure();
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return { url: null, error: "invalid document id" };
  const rows = await queryJson<{
    bucket: string | null;
    key: string | null;
    title: string | null;
    sealed: boolean | null;
  }>(
    `SELECT s3_bucket AS "bucket", s3_key AS "key", title AS "title", is_sealed AS "sealed"
     FROM corpus.docket_files WHERE file_id = CAST(:id AS uuid) LIMIT 1`,
    [param("id", documentId)],
  );
  const r = rows[0];
  if (!r) return { url: null, error: "Document not found" };
  if (!r.key) {
    return {
      url: null,
      error: r.sealed
        ? "This filing is sealed; no PDF is available."
        : "No PDF is stored for this entry (text-only docket entry).",
    };
  }
  try {
    const safe = (r.title ?? "document").replace(/["\r\n\\]/g, "_").slice(0, 180);
    const url = await getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: r.bucket || CORPUS_BUCKET,
        Key: r.key,
        ResponseContentDisposition: `inline; filename="${safe}.pdf"`,
        ResponseContentType: "application/pdf",
      }),
      { expiresIn: 1800 },
    );
    return { url };
  } catch (e) {
    return { url: null, error: e instanceof Error ? e.message : "Presign failed" };
  }
}

/** Presign PUT URLs for browser-direct uploads into <slug>/incoming/ on the corpus bucket. */
export async function uploadUrls(
  slug: string,
  files: { name: string; size: number }[],
  namespace?: string,
): Promise<{ name: string; key: string; url: string }[]> {
  ensure();
  const safe = (n: string) => n.replace(/[^A-Za-z0-9._()\- ]/g, "_").replace(/^\/+/, "");
  const ns = namespace
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const prefix = `${slug}/incoming/${ns ? `${ns}/` : ""}`;
  const out: { name: string; key: string; url: string }[] = [];
  for (const f of files.slice(0, 1000)) {
    const key0 = `${prefix}${Date.now()}-${safe(f.name)}`;
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({ Bucket: CORPUS_BUCKET, Key: key0 }),
      {
        expiresIn: 3600,
      },
    );
    out.push({ name: f.name, key: key0, url });
  }
  return out;
}

/** No pipeline-runs table in the Aurora corpus; the ingest history lives elsewhere. */
export async function loadPipelineRuns(_limit = 20): Promise<PipelineRun[]> {
  return [];
}
