/**
 * One-time (re-runnable) backfill: object-storage catalog -> registry.enrich_*
 *
 *   bun scripts/backfill-enrich.ts [--dry] [--limit-dockets N] [--no-pdfs]
 *
 * Requires CORPUS_SERVICE_KEY + AWS_* / S3_ENDPOINT in the environment.
 * Idempotent: upserts on doc_uid / entry_uid, so it can be stopped and re-run.
 */
import { presignS3, s3List } from "../src/lib/s3.server";

const SCHEMA = "registry";
const BUCKET = "kb-staging";
const CORPUS_URL = "https://odwhzepghulspdzmzhhz.supabase.co";
const KEY = process.env["CORPUS_SERVICE_KEY"];
if (!KEY) throw new Error("CORPUS_SERVICE_KEY not set");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const NO_PDFS = argv.includes("--no-pdfs");
const LIMIT_DOCKETS = (() => {
  const i = argv.indexOf("--limit-dockets");
  return i === -1 ? Infinity : Number(argv[i + 1]);
})();

const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function readRows(table: string, params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${CORPUS_URL}/rest/v1/${table}?${qs}`, {
      headers: { ...H, "Accept-Profile": SCHEMA, Range: `${off}-${off + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`read ${table}: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as any[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function upsert(table: string, rows: any[], onConflict: string) {
  if (DRY || !rows.length) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const body = JSON.stringify(rows.slice(i, i + CHUNK));
    const res = await fetch(`${CORPUS_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        ...H,
        "Content-Profile": SCHEMA,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body,
    });
    if (!res.ok) throw new Error(`upsert ${table}: ${res.status} ${await res.text()}`);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const norm = (court: string, dn: string) =>
  `${court.toLowerCase()}|${dn.replace(/\s+/g, "").toLowerCase()}`;

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log("· loading registry matters + aliases");
  const [matters, aliases] = await Promise.all([
    readRows("matters", { select: "matter_id,court_id,docket_number" }),
    readRows("matter_aliases", { select: "matter_id,namespace,value" }),
  ]);
  console.log(`  matters=${matters.length} aliases=${aliases.length}`);

  // docket_id -> matter_id, from aliases first, then court|docket_number.
  const docketToMatter = new Map<number, string>();
  for (const a of aliases) {
    if (a.namespace !== "courtlistener_docket_id" && a.namespace !== "courtlistener_master_docket_id")
      continue;
    const id = Number(a.value);
    if (Number.isFinite(id) && !docketToMatter.has(id)) docketToMatter.set(id, a.matter_id);
  }
  const byCourtDocket = new Map<string, string>();
  for (const m of matters) {
    if (m.court_id && m.docket_number) byCourtDocket.set(norm(m.court_id, m.docket_number), m.matter_id);
  }
  console.log(`  docket ids from aliases: ${docketToMatter.size}`);

  console.log("· fetching catalog/matters.json (docket id ↔ court/docket number)");
  const catalogMatters: any[] = await (
    await fetch(await presignS3(BUCKET, "catalog/matters.json", {}, 600))
  ).json();
  for (const cm of catalogMatters) {
    if (!cm.docket_id || docketToMatter.has(cm.docket_id)) continue;
    const mid = byCourtDocket.get(norm(cm.court ?? "", cm.docket_number ?? ""));
    if (mid) docketToMatter.set(cm.docket_id, mid);
  }
  console.log(`  resolvable dockets: ${docketToMatter.size}`);

  console.log("· fetching catalog document metadata");
  const catalogFiles = ["catalog/documents.json"].concat(
    (await s3List(BUCKET, "catalog/documents_by_master/", 5000)).map((o) => o.key),
  );
  const byUid = new Map<string, any>();
  await mapLimit(catalogFiles, 6, async (key) => {
    const arr: any[] = await (await fetch(await presignS3(BUCKET, key, {}, 900))).json();
    for (const d of arr) if (d?.doc_uid && !byUid.has(d.doc_uid)) byUid.set(d.doc_uid, d);
  });
  const allDocs = [...byUid.values()];
  console.log(`  catalog files=${catalogFiles.length} documents=${allDocs.length}`);

  // -- staged PDFs (the bulk of the missing content) --------------------------
  // recap-pdfs/<docket_id>/gov.uscourts.<court>.<pacer_case>.<entry>.<att>.pdf
  const PDF_NAME = /^recap-pdfs\/(\d+)\/gov\.uscourts\.([a-z0-9]+)\.(\d+)\.(\d+)\.(\d+)(?:_\d+)?\.pdf$/i;
  const pdfByDocket = new Map<number, Map<string, { key: string; size: number }[]>>();
  const pdfDockets = new Set<number>();
  let pdfObjects = 0;
  if (!NO_PDFS) {
    console.log("· indexing staged PDFs (recap-pdfs/)");
    const objs = await s3List(BUCKET, "recap-pdfs/", 1_000_000);
    for (const o of objs) {
      const m = PDF_NAME.exec(o.key);
      if (!m) continue;
      const docketId = Number(m[1]);
      pdfDockets.add(docketId);
      const slot = `${Number(m[4])}-${Number(m[5])}`; // entry-attachment
      const map = pdfByDocket.get(docketId) ?? new Map();
      const list = map.get(slot) ?? [];
      list.push({ key: o.key, size: o.size });
      map.set(slot, list);
      pdfByDocket.set(docketId, map);
      pdfObjects++;
    }
    for (const map of pdfByDocket.values())
      for (const list of map.values()) list.sort((a, b) => a.key.localeCompare(b.key));
    console.log(`  pdf objects=${pdfObjects} dockets=${pdfDockets.size}`);
  }

  // -- the docket universe: catalog dockets + staged-pdf dockets --------------
  const catalogDockets = new Set<number>(allDocs.map((d) => d.master_docket_id));
  const universe = [...new Set([...catalogDockets, ...pdfDockets])];
  const unmatchedDockets = new Set(universe.filter((d) => !docketToMatter.has(d)));
  const dockets = universe
    .filter((d) => docketToMatter.has(d))
    .slice(0, Number.isFinite(LIMIT_DOCKETS) ? LIMIT_DOCKETS : undefined);
  const docketSet = new Set(dockets);
  const docs = allDocs.filter((d) => docketSet.has(d.master_docket_id));
  console.log(
    `  dockets in registry=${dockets.length} unmatched=${unmatchedDockets.size}; catalog docs in scope=${docs.length}`,
  );

  // -- build rows ------------------------------------------------------------
  const usedKey = new Set<string>();
  const docRows: any[] = [];
  const entryAgg = new Map<string, any>();
  let pdfsLinked = 0;

  const takePdf = (docketId: number, entry: number | null, att: number | null) => {
    if (entry == null) return null;
    const map = pdfByDocket.get(docketId);
    if (!map) return null;
    const slots = att == null ? [`${entry}-0`, `${entry}-1`] : [`${entry}-${att}`];
    for (const s of slots) {
      const free = (map.get(s) ?? []).find((c) => !usedKey.has(c.key));
      if (free) {
        usedKey.add(free.key);
        pdfsLinked++;
        return free;
      }
    }
    return null;
  };

  const pushEntry = (
    docketId: number,
    matterId: string,
    entry: number | null,
    dateFiled: string | null,
    description: string | null,
    pages: number | null,
    hasPdf: boolean,
  ) => {
    if (entry == null) return;
    const uid = `${docketId}-${entry}`;
    const agg = entryAgg.get(uid) ?? {
      entry_uid: uid,
      matter_id: matterId,
      docket_id: docketId,
      entry_number: entry,
      entry_date_filed: null,
      entry_description: null,
      document_count: 0,
      page_count: 0,
      has_pdf: false,
    };
    agg.document_count += 1;
    agg.page_count += pages ?? 0;
    agg.has_pdf = agg.has_pdf || hasPdf;
    if (!agg.entry_date_filed && dateFiled) agg.entry_date_filed = dateFiled;
    if (!agg.entry_description && description) agg.entry_description = description;
    entryAgg.set(uid, agg);
  };

  for (const d of docs) {
    const docketId = d.master_docket_id as number;
    const matterId = docketToMatter.get(docketId)!;
    const entry = typeof d.entry_number === "number" ? d.entry_number : null;
    const pdf = takePdf(docketId, entry, d.attachment_number ?? null);
    const s3Key = pdf?.key ?? null;


    docRows.push({
      doc_uid: d.doc_uid,
      matter_id: matterId,
      docket_id: docketId,
      entry_number: entry,
      document_number: d.document_number == null ? null : String(d.document_number),
      attachment_number: d.attachment_number ?? null,
      entry_date_filed: d.entry_date_filed || null,
      entry_description: d.entry_description || null,
      document_description: d.document_description || null,
      doc_category: d.doc_category ?? null,
      document_type: typeof d.document_type === "number" ? d.document_type : null,
      high_value: Boolean(d.high_value),
      page_count: d.page_count ?? null,
      file_size: d.file_size ?? null,
      is_available: d.is_available !== false,
      is_sealed: Boolean(d.is_sealed),
      pacer_doc_id: d.pacer_doc_id ? String(d.pacer_doc_id) : null,
      courtlistener_url: d.courtlistener_url ?? null,
      download_url: d.download_url ?? null,
      sha1: d.sha1 ?? null,
      s3_bucket: s3Key ? BUCKET : null,
      s3_key: s3Key,
    });

    pushEntry(
      docketId,
      matterId,
      entry,
      d.entry_date_filed || null,
      d.entry_description || null,
      d.page_count ?? null,
      Boolean(s3Key),
    );
  }

  // -- PDF-only documents: staged files with no catalog metadata -------------
  let pdfOnly = 0;
  for (const docketId of dockets) {
    const map = pdfByDocket.get(docketId);
    if (!map) continue;
    const matterId = docketToMatter.get(docketId)!;
    for (const [slot, list] of map) {
      const [entryStr, attStr] = slot.split("-");
      const entry = Number(entryStr);
      const att = Number(attStr);
      for (const obj of list) {
        if (usedKey.has(obj.key)) continue;
        usedKey.add(obj.key);
        pdfOnly++;
        pdfsLinked++;
        docRows.push({
          doc_uid: `${docketId}-${entry}-p${att}-${obj.key.split("/").pop()}`.slice(0, 300),
          matter_id: matterId,
          docket_id: docketId,
          entry_number: entry,
          document_number: String(entry),
          attachment_number: att || null,
          entry_date_filed: null,
          entry_description: null,
          document_description: att ? `Attachment ${att}` : null,
          doc_category: null,
          document_type: att ? 2 : 1,
          high_value: false,
          page_count: null,
          file_size: obj.size,
          is_available: true,
          is_sealed: false,
          pacer_doc_id: null,
          courtlistener_url: null,
          download_url: null,
          sha1: null,
          s3_bucket: BUCKET,
          s3_key: obj.key,
        });
        pushEntry(docketId, matterId, entry, null, null, null, true);
      }
    }
  }
  console.log(`  pdf-only documents: ${pdfOnly}`);

  const entryRows = [...entryAgg.values()].map((e) => ({ ...e, page_count: e.page_count || null }));


  console.log(
    `· upserting documents=${docRows.length} entries=${entryRows.length} pdfsLinked=${pdfsLinked}${DRY ? " (dry run)" : ""}`,
  );
  await upsert("enrich_documents", docRows, "doc_uid");
  await upsert("enrich_entries", entryRows, "entry_uid");

  if (!DRY) {
    await fetch(`${CORPUS_URL}/rest/v1/enrich_load_runs`, {
      method: "POST",
      headers: { ...H, "Content-Profile": SCHEMA, Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          finished_at: new Date().toISOString(),
          status: "ok",
          source: "kb-staging/catalog + recap-pdfs",
          dockets_matched: dockets.length,
          dockets_unmatched: unmatchedDockets.size,
          documents_upserted: docRows.length,
          entries_upserted: entryRows.length,
          pdfs_linked: pdfsLinked,
          notes: { catalogDocuments: allDocs.length, pdfObjects, pdfOnly, noPdfs: NO_PDFS },
        },
      ]),
    });
  }

  console.log(`✓ done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
