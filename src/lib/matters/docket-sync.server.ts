// Incremental sync of followed hub dockets (federal transferee + JPML) from
// DocketBird into the matters corpus: new docket entries become
// corpus.docket_files rows, newly available PDFs land in the corpus bucket with
// a KB metadata sidecar, and corpus.dockets counters advance. This is what makes
// "Auto-updating" on the matters page true.
//
// Contract with the one-time backfill (kb-poc/backfill-docket.mjs): same S3 key
// convention <slug>/<scope>/<court>__<number>/<entry5>-<attach3>.pdf, same
// sidecar shape, same doc_type vocabulary. Existing rows are matched by
// docketbird_document_id, so attachment numbering never shifts; new documents
// on an existing entry take the next free attachment slot.
//
// Every run is bounded (dockets, PDF downloads, wall clock) because the caller
// is an HTTP handler behind a 300 s gateway timeout. Whatever does not fit is
// picked up by the next scheduled run.
import { createHash } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  docketbirdConfigured,
  getDocketSheetFull,
  type DbSheetRow,
} from "@/lib/agents/docketbird.server";
import { execute, kbConfigured, param, queryJson } from "@/lib/kb/aurora.server";

const CORPUS_BUCKET =
  process.env["MATTERS_CORPUS_BUCKET"] ||
  process.env["CORPUS_BUCKET"] ||
  "sw-matters-corpus-475976462949";
const REGION = process.env["AWS_REGION"] || "us-east-1";

let _s3: S3Client | undefined;
const s3 = () => (_s3 ??= new S3Client({ region: REGION }));

export type SyncOptions = {
  /** Wall-clock budget for the whole call (ms). Default 240 s. */
  deadlineMs?: number;
  /** Max PDF downloads per docket per run. Default 40. */
  maxDownloads?: number;
  signal?: AbortSignal;
};

export type DocketSyncResult = {
  docketId: string;
  matterId: string;
  sheetRows: number;
  newRows: number;
  updatedRows: number;
  pdfsDownloaded: number;
  pdfsPending: number;
  skipped?: string;
  error?: string;
  ms: number;
};

type DocketRow = {
  docketId: string;
  matterId: string;
  scope: string;
  courtId: string;
  docketNumber: string;
  lastSyncedAt: string | null;
};

type FileRow = {
  dbId: string | null;
  entry: number | null;
  attach: number;
  hasPdf: boolean;
  sealed: boolean;
};

// The Data API caps a response at 1 MB; mega-MDL dockets (Roundup JPML has
// 12k rows) need paging. Titles are not needed for the diff, so they stay out.
const EXISTING_PAGE = 2000;

async function loadExistingRows(docketId: string): Promise<FileRow[]> {
  const out: FileRow[] = [];
  for (let offset = 0; ; offset += EXISTING_PAGE) {
    const page = await queryJson<FileRow>(
      `SELECT docketbird_document_id AS "dbId", entry_number AS "entry", COALESCE(attachment_number,0) AS "attach",
              (s3_key IS NOT NULL) AS "hasPdf", COALESCE(is_sealed,false) AS "sealed"
       FROM corpus.docket_files WHERE docket_id = :id
       ORDER BY entry_number NULLS FIRST, attachment_number NULLS FIRST, file_id
       LIMIT :lim OFFSET :off`,
      [param("id", docketId), param("lim", EXISTING_PAGE), param("off", offset)],
    );
    out.push(...page);
    if (page.length < EXISTING_PAGE) break;
  }
  return out;
}

// Same vocabulary as the backfill.
export function classifyDocType(title: string): string {
  const t = (title || "").toLowerCase();
  if (/case management order|\bcmo\b/.test(t)) return "cmo";
  if (/transfer order|\bcto\b/.test(t)) return "transfer_order";
  if (/\bopinion\b/.test(t)) return "opinion";
  if (/\border\b/.test(t)) return "order";
  if (/complaint/.test(t)) return "complaint";
  if (/motion|\bmtd\b/.test(t)) return "motion";
  if (/notice/.test(t)) return "notice";
  if (/brief|memorandum/.test(t)) return "brief";
  return "other";
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const safeSeg = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");

export function objectKey(
  d: { matterId: string; scope: string; courtId: string; docketNumber: string },
  entry: number,
  attach: number,
): string {
  return `${d.matterId}/${d.scope}/${safeSeg(`${d.courtId}__${d.docketNumber}`)}/${pad(entry, 5)}-${pad(attach, 3)}.pdf`;
}

export function syncConfigured(): boolean {
  return kbConfigured() && docketbirdConfigured();
}

/** Followed hub dockets, least recently synced first. */
export async function listSyncCandidates(limit: number): Promise<DocketRow[]> {
  return queryJson<DocketRow>(
    `SELECT docket_id AS "docketId", matter_id AS "matterId", scope AS "scope", court_id AS "courtId",
            docket_number AS "docketNumber", last_synced_at AS "lastSyncedAt"
     FROM corpus.dockets
     WHERE followed_in_db = true AND scope IN ('federal','jpml')
     ORDER BY last_synced_at ASC NULLS FIRST, docket_id
     LIMIT :lim`,
    [param("lim", Math.max(1, Math.min(limit, 50)))],
  );
}

async function loadDocket(docketId: string): Promise<DocketRow | null> {
  const rows = await queryJson<DocketRow>(
    `SELECT docket_id AS "docketId", matter_id AS "matterId", scope AS "scope", court_id AS "courtId",
            docket_number AS "docketNumber", last_synced_at AS "lastSyncedAt"
     FROM corpus.dockets WHERE docket_id = :id LIMIT 1`,
    [param("id", docketId)],
  );
  return rows[0] ?? null;
}

async function downloadPdf(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, 4).toString() === "%PDF" ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type SidecarValue = string | number | boolean | null | undefined;

/** Bedrock-safe metadata: booleans as strings, null/undefined dropped. */
export function sidecarAttributes(
  attrs: Record<string, SidecarValue>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "boolean" ? String(v) : v;
  }
  return out;
}

async function putPdf(
  d: DocketRow,
  key: string,
  buf: Buffer,
  meta: {
    entry: number;
    attach: number;
    docType: string;
    dateFiled: string | null;
    dbId: string;
    title: string;
  },
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: CORPUS_BUCKET,
      Key: key,
      Body: buf,
      ContentType: "application/pdf",
    }),
  );
  // Managed KB S3 connector: a document whose sidecar carries a JSON boolean (or
  // null) is silently skipped ("could not be crawled"). Booleans go out as the
  // strings "true"/"false"; absent values are omitted rather than null.
  const sidecar = {
    metadataAttributes: sidecarAttributes({
      matter_slug: d.matterId,
      scope: d.scope,
      court_id: d.courtId,
      docket_number: d.docketNumber,
      is_lead_docket: d.scope !== "jpml",
      entry_number: meta.entry,
      attachment_number: meta.attach,
      doc_type: meta.docType,
      date_filed: meta.dateFiled ? Number(meta.dateFiled.replace(/-/g, "")) : null,
      is_sealed: false,
      title: meta.title.slice(0, 200) || null,
      docketbird_document_id: meta.dbId,
      source: "docketbird",
    }),
  };
  await s3().send(
    new PutObjectCommand({
      Bucket: CORPUS_BUCKET,
      Key: `${key}.metadata.json`,
      Body: JSON.stringify(sidecar),
      ContentType: "application/json",
    }),
  );
}

/**
 * Sync one docket. Idempotent: rerunning after a partial run only does the
 * remaining work.
 */
export async function syncDocket(
  docketId: string,
  opts: SyncOptions = {},
): Promise<DocketSyncResult> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? 240_000);
  const maxDownloads = opts.maxDownloads ?? 40;
  const base: DocketSyncResult = {
    docketId,
    matterId: "",
    sheetRows: 0,
    newRows: 0,
    updatedRows: 0,
    pdfsDownloaded: 0,
    pdfsPending: 0,
    ms: 0,
  };
  const finish = (r: Partial<DocketSyncResult>) => ({ ...base, ...r, ms: Date.now() - started });

  const d = await loadDocket(docketId);
  if (!d) return finish({ error: "docket not found" });
  base.matterId = d.matterId;
  if (d.scope !== "federal" && d.scope !== "jpml")
    return finish({ skipped: "only hub dockets sync from DocketBird" });

  let sheet: DbSheetRow[];
  try {
    sheet = await getDocketSheetFull(docketId, {
      timeoutMs: 90_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    return finish({ error: `DocketBird sheet: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!sheet.length) return finish({ skipped: "empty docket sheet" });

  const existing = await loadExistingRows(docketId);
  const byDbId = new Map<string, FileRow>();
  const attachTaken = new Map<number, Set<number>>();
  for (const f of existing) {
    if (f.dbId) byDbId.set(f.dbId, f);
    if (f.entry != null) {
      const set = attachTaken.get(Number(f.entry)) ?? new Set<number>();
      set.add(Number(f.attach));
      attachTaken.set(Number(f.entry), set);
    }
  }
  const nextAttach = (entry: number): number => {
    const set = attachTaken.get(entry) ?? new Set<number>();
    let a = 0;
    while (set.has(a)) a++;
    set.add(a);
    attachTaken.set(entry, set);
    return a;
  };

  let newRows = 0;
  let updatedRows = 0;
  let downloaded = 0;
  let pending = 0;

  for (const row of sheet) {
    if (opts.signal?.aborted) break;
    const entry = row.entry_number ?? 0;
    const docType = classifyDocType(row.title);
    const known = byDbId.get(row.id);
    const canDownload = !row.restricted && row.downloaded && !!row.document_url;

    if (!known) {
      const attach = nextAttach(entry);
      let key: string | null = null;
      let bytes: number | null = null;
      let sha: string | null = null;
      if (canDownload) {
        if (downloaded < maxDownloads && Date.now() < deadline - 20_000) {
          const buf = await downloadPdf(row.document_url!, opts.signal);
          if (buf) {
            key = objectKey(d, entry, attach);
            await putPdf(d, key, buf, {
              entry,
              attach,
              docType,
              dateFiled: row.filing_date,
              dbId: row.id,
              title: row.title,
            });
            bytes = buf.length;
            sha = createHash("sha256").update(buf).digest("hex");
            downloaded++;
          } else pending++;
        } else pending++;
      }
      await execute(
        `INSERT INTO corpus.docket_files
           (docket_id, matter_id, docketbird_document_id, entry_number, attachment_number, title, doc_type, date_filed,
            is_sealed, byte_count, sha256, s3_bucket, s3_key, source)
         VALUES (:docketId, :matterId, :dbId, :entry, :attach, :title, :docType, CAST(:dateFiled AS date),
                 :sealed, :bytes, :sha, :bucket, :key, 'docketbird')
         ON CONFLICT (docket_id, entry_number, attachment_number) DO NOTHING`,
        [
          param("docketId", docketId),
          param("matterId", d.matterId),
          param("dbId", row.id),
          param("entry", entry),
          param("attach", attach),
          param("title", row.title.slice(0, 1200)),
          param("docType", docType),
          param("dateFiled", row.filing_date),
          param("sealed", row.restricted),
          param("bytes", bytes),
          param("sha", sha),
          param("bucket", key ? CORPUS_BUCKET : null),
          param("key", key),
        ],
      );
      newRows++;
      continue;
    }

    // Known row: fetch a PDF that became available, or reflect a seal change.
    const wantsPdf = canDownload && !known.hasPdf;
    const sealChanged = known.sealed !== row.restricted;
    if (!wantsPdf && !sealChanged) continue;
    if (wantsPdf) {
      if (downloaded >= maxDownloads || Date.now() >= deadline - 20_000) {
        pending++;
        continue;
      }
      const buf = await downloadPdf(row.document_url!, opts.signal);
      if (!buf) {
        pending++;
        continue;
      }
      const entryNum = known.entry ?? entry;
      const key = objectKey(d, entryNum, known.attach);
      await putPdf(d, key, buf, {
        entry: entryNum,
        attach: known.attach,
        docType,
        dateFiled: row.filing_date,
        dbId: row.id,
        title: row.title,
      });
      await execute(
        `UPDATE corpus.docket_files
            SET s3_bucket = :bucket, s3_key = :key, byte_count = :bytes, sha256 = :sha, is_sealed = :sealed,
                title = COALESCE(NULLIF(:title,''), title), doc_type = CASE WHEN doc_type IS NULL OR doc_type = 'other' THEN :docType ELSE doc_type END
          WHERE docket_id = :docketId AND docketbird_document_id = :dbId`,
        [
          param("bucket", CORPUS_BUCKET),
          param("key", key),
          param("bytes", buf.length),
          param("sha", createHash("sha256").update(buf).digest("hex")),
          param("sealed", row.restricted),
          param("title", row.title.slice(0, 1200)),
          param("docType", docType),
          param("docketId", docketId),
          param("dbId", row.id),
        ],
      );
      downloaded++;
      updatedRows++;
    } else {
      await execute(
        `UPDATE corpus.docket_files SET is_sealed = :sealed WHERE docket_id = :docketId AND docketbird_document_id = :dbId`,
        [param("sealed", row.restricted), param("docketId", docketId), param("dbId", row.id)],
      );
      updatedRows++;
    }
  }

  // Counters the matters page reads.
  await execute(
    `UPDATE corpus.dockets d SET
        entry_count = :sheetRows,
        files_present = s.pdfs,
        pdf_available = s.pdfs,
        sealed_count = s.sealed,
        missing_count = GREATEST(:sheetRows - s.pdfs - s.sealed, 0),
        completion_pct = ROUND(100.0 * s.pdfs / NULLIF(:sheetRows - s.sealed, 0), 1),
        followed_in_db = true,
        last_synced_at = now()
     FROM (
       SELECT count(*) FILTER (WHERE s3_key IS NOT NULL) AS pdfs, count(*) FILTER (WHERE is_sealed) AS sealed
       FROM corpus.docket_files WHERE docket_id = :docketId
     ) s
     WHERE d.docket_id = :docketId`,
    [param("sheetRows", sheet.length), param("docketId", docketId)],
  );

  return finish({
    sheetRows: sheet.length,
    newRows,
    updatedRows,
    pdfsDownloaded: downloaded,
    pdfsPending: pending,
  });
}

/**
 * Sync the least recently synced hub dockets until the docket cap or the
 * deadline is reached. Errors are per docket; one failure never stops the rest.
 */
export async function syncFollowedDockets(
  opts: SyncOptions & { maxDockets?: number } = {},
): Promise<{
  results: DocketSyncResult[];
  ms: number;
}> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? 240_000);
  const candidates = await listSyncCandidates(opts.maxDockets ?? 3);
  const results: DocketSyncResult[] = [];
  for (const c of candidates) {
    const remaining = deadline - Date.now();
    if (remaining < 30_000) break;
    try {
      results.push(
        await syncDocket(c.docketId, {
          ...opts,
          deadlineMs: remaining,
          maxDownloads: opts.maxDownloads ?? 40,
        }),
      );
    } catch (e) {
      results.push({
        docketId: c.docketId,
        matterId: c.matterId,
        sheetRows: 0,
        newRows: 0,
        updatedRows: 0,
        pdfsDownloaded: 0,
        pdfsPending: 0,
        error: e instanceof Error ? e.message : String(e),
        ms: 0,
      });
    }
  }
  // New PDFs landed in S3 for these matters — refresh their KB vector index so
  // matter_corpus_search can retrieve them. Best-effort; never fails the sync.
  const touched = [
    ...new Set(results.filter((r) => r.pdfsDownloaded > 0).map((r) => r.matterId).filter(Boolean)),
  ];
  if (touched.length) {
    try {
      const { triggerMatterIngestion } = await import("./matter-ingest.server");
      await triggerMatterIngestion(touched);
    } catch (e) {
      console.error(
        `[docket-sync] ingestion trigger failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { results, ms: Date.now() - started };
}
