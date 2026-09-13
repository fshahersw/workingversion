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
// One pass over docket_files for every matter (grouped CTEs), instead of three
// correlated lateral scans per matter. The old shape seq-scanned the whole
// docket_files table once per matter (150k rows x 35 matters) and took ~1.6 s
// warm; this runs in a fraction of that and scales with corpus size, not
// corpus size x matter count. `WHERE_MATTER` is spliced into each CTE so the
// single-matter workspace load only aggregates that matter's rows.
const matterSelect = (whereMatter = "") => `
  WITH per_docket AS (
    SELECT d.matter_id, d.docket_id, d.scope,
           count(f.file_id) AS files,
           count(DISTINCT f.entry_number) AS entries,
           count(f.s3_key) AS with_pdf,
           count(*) FILTER (WHERE f.is_sealed) AS sealed
    FROM corpus.dockets d
    LEFT JOIN corpus.docket_files f ON f.docket_id = d.docket_id
    ${whereMatter ? `WHERE ${whereMatter.replace(/\bm\./g, "d.")}` : ""}
    GROUP BY d.matter_id, d.docket_id, d.scope
  ),
  agg AS (
    SELECT matter_id,
           sum(entries) AS entries, sum(files) AS documents,
           sum(with_pdf) AS with_pdf, sum(sealed) AS sealed
    FROM per_docket GROUP BY matter_id
  ),
  sc AS (
    SELECT matter_id,
           jsonb_object_agg(scope, jsonb_build_object('dockets', dockets, 'files', files)) AS counts
    FROM (
      SELECT matter_id, scope, count(*) AS dockets, sum(files) AS files
      FROM per_docket GROUP BY matter_id, scope
    ) s GROUP BY matter_id
  ),
  synced AS (
    SELECT matter_id, max(last_synced_at) AS last_synced_at FROM corpus.dockets GROUP BY matter_id
  )
  SELECT m.matter_id AS "slug", m.title AS "title", m.mdl_number AS "mdlNumber",
    ld.court_id AS "courtId", ld.docket_number AS "docketNumber",
    agg.entries AS "entries", agg.documents AS "documents", agg.with_pdf AS "withPdf", agg.sealed AS "sealed",
    sc.counts AS "scopeCounts",
    synced.last_synced_at AS "lastSyncedAt"
  FROM corpus.matters m
  LEFT JOIN agg ON agg.matter_id = m.matter_id
  LEFT JOIN sc ON sc.matter_id = m.matter_id
  LEFT JOIN synced ON synced.matter_id = m.matter_id
  LEFT JOIN LATERAL (
    SELECT d.court_id, d.docket_number FROM corpus.dockets d
    WHERE d.matter_id = m.matter_id
    ORDER BY (d.docket_id = m.lead_case_id) DESC,
             CASE d.scope WHEN 'federal' THEN 0 WHEN 'jpml' THEN 1 WHEN 'state' THEN 2 ELSE 3 END,
             d.is_lead DESC
    LIMIT 1
  ) ld ON true
  ${whereMatter ? `WHERE ${whereMatter}` : ""}
`;

// Matters change only when a sync or backfill lands (every 30 minutes at most),
// so a short per-container memo turns repeat navigations into a no-op.
const LIST_TTL_MS = 60_000;
let listCache: { at: number; rows: MatterListItem[] } | null = null;

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
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.rows;
  const rows = await queryJson<MatterRow>(`${matterSelect()} ORDER BY m.title`);
  const items = rows.map(toMatterItem);
  listCache = { at: Date.now(), rows: items };
  return items;
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
  assignedJudge: string | null;
  referredJudge: string | null;
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
    assignedJudge: r.assignedJudge?.trim() || null,
    referredJudge: r.referredJudge?.trim() || null,
  };
}

// --- court reference layer ---------------------------------------------------

type CourtRow = {
  key: string;
  name: string;
  level: string;
  jurisdiction: string;
  website: string | null;
  formsPages: string | string[] | null;
  logoKey: string | null;
  logoKind: string | null;
  logoBackground: string | null;
  fallbackText: string;
  reuseNote: string | null;
};

type JudgeRow = { name: string; surname: string; courtKey: string; portraitKey: string | null; sourcePage: string | null };

const ASSET_TTL = 6 * 3600; // logos and portraits are stable; a long-lived URL keeps the header cacheable

async function presign(key: string | null | undefined, expiresIn = ASSET_TTL): Promise<string | null> {
  if (!key) return null;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: CORPUS_BUCKET, Key: key }), { expiresIn });
  } catch {
    return null;
  }
}

/** Surname-based match between a docket's recorded judge ("Vince Girdhari Chhabria")
 *  and the library's official portrait record ("Vince Chhabria"), same court only. */
function judgeMatches(recorded: string, j: JudgeRow): boolean {
  const tokens = recorded.toLowerCase().replace(/[^\p{L}\s'’-]/gu, " ").split(/\s+/).filter(Boolean);
  const surname = j.surname.toLowerCase();
  if (!tokens.includes(surname)) return false;
  // Guard against two judges sharing a surname on one court: require the first name too.
  const first = j.name.toLowerCase().split(/\s+/)[0];
  return tokens.includes(first);
}

async function loadCourtLayer(
  dockets: WorkspaceDocket[],
): Promise<{ court: CourtIdentity | null; judges: JudgeIdentity[] }> {
  const lead = dockets.find((d) => d.isLead && d.scope === "federal") ?? dockets.find((d) => d.scope === "federal") ?? dockets.find((d) => d.isLead) ?? dockets[0];
  const keys = courtReferenceKeys(lead?.courtId);
  if (!lead || !keys.length) return { court: null, judges: [] };
  const [courtRows, countRows, judgeRows] = await Promise.all([
    queryJson<CourtRow>(
      `SELECT court_key AS "key", name, level, jurisdiction, website, forms_pages AS "formsPages",
              logo_key AS "logoKey", logo_kind AS "logoKind", logo_background AS "logoBackground",
              fallback_text AS "fallbackText", reuse_note AS "reuseNote"
       FROM reference.courts WHERE court_key = :key`,
      [param("key", keys[0])],
    ),
    queryJson<{ kind: string; count: number }>(
      `SELECT kind, count(*) AS "count" FROM reference.court_documents
       WHERE court_keys && ${listCast("keys", "text")} GROUP BY kind`,
      [listParam("keys", keys)],
    ),
    queryJson<JudgeRow>(
      `SELECT name, surname, court_key AS "courtKey", portrait_key AS "portraitKey", source_page AS "sourcePage"
       FROM reference.judges WHERE court_key = :key`,
      [param("key", keys[0])],
    ),
  ]);
  const c = courtRows[0];
  const counts = Object.fromEntries(COURT_RESOURCE_KINDS.map((k) => [k, 0])) as Record<CourtResourceKind, number>;
  for (const r of countRows) if (r.kind in counts) counts[r.kind as CourtResourceKind] = num(r.count);
  const court: CourtIdentity | null = c
    ? {
        key: c.key,
        name: c.name,
        level: c.level,
        jurisdiction: c.jurisdiction,
        website: c.website,
        formsPages: Array.isArray(c.formsPages) ? c.formsPages : safeJsonArray(c.formsPages),
        logoUrl: await presign(c.logoKey),
        logoKind: c.logoKind,
        logoBackground: c.logoBackground === "dark" ? "dark" : c.logoBackground === "light" ? "light" : null,
        fallbackText: c.fallbackText,
        reuseNote: c.reuseNote,
        resourceCounts: counts,
      }
    : null;
  // Portraits appear only for a judge the docket itself names. Never inferred.
  const judges: JudgeIdentity[] = [];
  for (const [role, recorded] of [["assigned", lead.assignedJudge], ["referred", lead.referredJudge]] as const) {
    if (!recorded) continue;
    const hit = judgeRows.find((j) => judgeMatches(recorded, j));
    judges.push({
      name: recorded,
      courtKey: keys[0],
      portraitUrl: hit ? await presign(hit.portraitKey) : null,
      sourcePage: hit?.sourcePage ?? null,
      role,
    });
  }
  return { court, judges };
}

function safeJsonArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type ResourceRow = {
  sha256: string;
  title: string;
  kind: string;
  format: string;
  bytes: number | null;
  pageCount: number | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  sourceDateKind: string | null;
  reviewStatus: string | null;
  fillable: boolean | null;
  judgeName: string | null;
  courtKey: string | null;
};

const WORD_FORMATS = ["docx", "doc", "rtf"];

/** Court rules, standing orders, forms and templates the library holds for a court. */
export async function listCourtResources(q: CourtResourceQuery): Promise<CourtResourcePage> {
  ensure();
  const keys = q.courtKeys.filter((k) => /^[A-Z]{1,3}:[a-z0-9_-]+$/.test(k)).slice(0, 4);
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  if (!keys.length) return { total: 0, page, pageSize, items: [] };
  const where = [`d.court_keys && ${listCast("keys", "text")}`];
  const params: SqlParameter[] = [listParam("keys", keys)];
  if (q.kind && (COURT_RESOURCE_KINDS as string[]).includes(q.kind)) {
    params.push(param("kind", q.kind));
    where.push("d.kind = :kind");
  }
  if (q.format === "word") where.push(`d.format = ANY(ARRAY['docx','doc','rtf'])`);
  else if (q.format === "pdf") where.push("d.format = 'pdf'");
  const search = q.search?.trim();
  if (search) {
    params.push(param("q", search.slice(0, 200)));
    where.push("d.title ILIKE '%' || :q || '%'");
  }
  const w = where.join(" AND ");
  const [countRows, rows] = await Promise.all([
    queryJson<{ count: number }>(`SELECT count(*) AS "count" FROM reference.court_documents d WHERE ${w}`, params),
    queryJson<ResourceRow>(
      `SELECT d.sha256, d.title, d.kind, d.format, d.bytes, d.page_count AS "pageCount",
              d.source_url AS "sourceUrl", d.source_date AS "sourceDate", d.source_date_kind AS "sourceDateKind",
              d.review_status AS "reviewStatus", d.fillable, d.judge_name AS "judgeName", d.court_key AS "courtKey"
       FROM reference.court_documents d
       WHERE ${w}
       ORDER BY CASE d.kind WHEN 'standing_order' THEN 0 WHEN 'local_rule' THEN 1 WHEN 'form' THEN 2 WHEN 'instruction' THEN 3 WHEN 'order' THEN 4 ELSE 5 END,
                d.title
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    ),
  ]);
  // Portraits for standing orders that name a judge: one lookup per distinct judge on this court.
  const judgeRows = rows.some((r) => r.judgeName)
    ? await queryJson<JudgeRow>(
        `SELECT name, surname, court_key AS "courtKey", portrait_key AS "portraitKey", source_page AS "sourcePage"
         FROM reference.judges WHERE court_key = ANY(${listCast("keys", "text")})`,
        [listParam("keys", keys)],
      )
    : [];
  const portraitCache = new Map<string, Promise<string | null>>();
  const items: CourtResource[] = await Promise.all(
    rows.map(async (r) => {
      const hit = r.judgeName ? judgeRows.find((j) => judgeMatches(r.judgeName!, j)) : undefined;
      let judgePortraitUrl: string | null = null;
      if (hit?.portraitKey) {
        if (!portraitCache.has(hit.portraitKey)) portraitCache.set(hit.portraitKey, presign(hit.portraitKey));
        judgePortraitUrl = await portraitCache.get(hit.portraitKey)!;
      }
      return {
        sha256: r.sha256,
        title: r.title,
        kind: (COURT_RESOURCE_KINDS as string[]).includes(r.kind) ? (r.kind as CourtResourceKind) : "other",
        format: (WORD_FORMATS.includes(r.format) || r.format === "pdf" ? r.format : "pdf") as CourtResource["format"],
        bytes: r.bytes == null ? null : num(r.bytes),
        pageCount: r.pageCount == null ? null : num(r.pageCount),
        sourceUrl: r.sourceUrl,
        sourceDate: r.sourceDate,
        sourceDateKind: r.sourceDateKind,
        reviewStatus: r.reviewStatus,
        fillable: !!r.fillable,
        judgeName: r.judgeName,
        judgePortraitUrl,
        courtKey: r.courtKey,
      };
    }),
  );
  return { total: num(countRows[0]?.count), page, pageSize, items };
}

/** Presigned URL to open an original court document from the library (30 minutes). */
export async function courtResourceUrl(sha256: string): Promise<{ url: string; title: string; format: string } | null> {
  ensure();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const rows = await queryJson<{ s3Key: string; title: string; format: string }>(
    `SELECT s3_key AS "s3Key", title, format FROM reference.court_documents WHERE sha256 = :sha`,
    [param("sha", sha256)],
  );
  const r = rows[0];
  if (!r) return null;
  const url = await presign(r.s3Key, 1800);
  return url ? { url, title: r.title, format: r.format } : null;
}

export async function loadWorkspace(slug: string): Promise<MatterWorkspace | null> {
  ensure();
  const [matterRows, docketRows, facets, range] = await Promise.all([
    queryJson<MatterRow>(`${matterSelect("m.matter_id = :slug")} LIMIT 1`, [param("slug", slug)]),
    queryJson<DocketRow>(
      `SELECT d.docket_id AS "docketId", d.scope AS "scope", d.court_id AS "courtId",
              d.docket_number AS "docketNumber", d.title AS "title", d.is_lead AS "isLead",
              d.entry_count AS "entryCount",
              (SELECT count(*) FROM corpus.docket_files f WHERE f.docket_id = d.docket_id) AS "filesPresent",
              (SELECT count(*) FROM corpus.docket_files f WHERE f.docket_id = d.docket_id AND f.s3_key IS NOT NULL) AS "pdfAvailable",
              d.sealed_count AS "sealedCount", d.missing_count AS "missingCount",
              d.completion_pct AS "completionPct", d.followed_in_db AS "followed", d.last_synced_at AS "lastSyncedAt",
              d.assigned_judge AS "assignedJudge", d.referred_judge AS "referredJudge"
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
  const dockets = docketRows.map(toDocket);
  // The court layer is additive: a failure there must not take the matter down.
  const { court, judges } = await loadCourtLayer(dockets).catch(() => ({ court: null, judges: [] }));

  return {
    matter: toMatterItem(m),
    dockets,
    parties: [], // Parties / counsel are not modeled in Aurora yet (CourtListener scrape pending).
    counsel: [],
    typeFacets: facets.map((f) => ({ type: f.type, count: num(f.count) })),
    dateRange: { first: range[0]?.first ?? null, last: range[0]?.last ?? null },
    court,
    judges,
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
