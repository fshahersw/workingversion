// ============================================================================
// Live end-to-end ETL self-test.
//
// Runs the real contract-v1 HTTP path (create -> upload -> validate -> commit)
// against a throwaway matter, then executes the ingest stages (store, write,
// extract, chunk, embed, finalize) and asserts the resulting corpus state.
//
// Safety invariants:
//  * the slug is always `selftest-<timestamp>`; the corpus write RPCs reject
//    any slug that does not match `^selftest-[a-z0-9-]+$`
//  * teardown runs in `finally` and deletes every object and row it created
//  * no real matter is read, written, or locked at any point
// ============================================================================
import { corpusUrl, MATTERS_BUCKET } from "@/lib/corpus";
import { parseCsv, compact } from "./csv";
import {
  canonicalPdfKey,
  canonicalTextKey,
  docketRow,
  incomingKey,
  manifest as manifestSchema,
  partyRow,
  slotKey,
  validateBatch,
  type DocketRow,
  type Manifest,
} from "./schema";
import { chunkPages, extractPdf, isPdf, sha256Hex } from "./pdf.server";
import {
  deleteObject,
  getBytes,
  putBytes,
  putText,
  rpc,
} from "./store.server";
import { FIXTURE_DOCKET_CSV, FIXTURE_MANIFEST, FIXTURE_PARTIES_CSV, FIXTURE_PDFS, fixtureBytes } from "./selftest-fixture.server";
import { embedText } from "@/lib/pile/titan.server";

export type StepStatus = "pass" | "fail" | "skip";
export type Step = {
  id: string;
  label: string;
  status: StepStatus;
  ms: number;
  detail: string;
  data?: Record<string, unknown>;
};
export type SelfTestReport = {
  run_id: string;
  slug: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  steps: Step[];
  cleanup: { objects_deleted: number; objects_failed: string[]; rows: unknown };
};

const now = () => Date.now();

class Runner {
  steps: Step[] = [];
  async step<T>(id: string, label: string, fn: () => Promise<[string, T, Record<string, unknown>?]>): Promise<T> {
    const t0 = now();
    try {
      const [detail, value, data] = await fn();
      this.steps.push({ id, label, status: "pass", ms: now() - t0, detail, ...(data ? { data } : {}) });
      return value;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.steps.push({ id, label, status: "fail", ms: now() - t0, detail });
      throw e;
    }
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export async function runSelfTest(origin: string): Promise<SelfTestReport> {
  const startedAt = new Date();
  const stamp = `${startedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const slug = `selftest-${stamp}`;
  const runner = new Runner();
  const createdKeys = new Set<string>();
  const ingestKey = process.env["INGEST_API_KEY"];
  let ok = false;

  try {
    assert(ingestKey, "INGEST_API_KEY is not configured — the ingest API is disabled");

    // ---------------------------------------------------------- 1. schema --
    const { m, rows, parties } = await runner.step("schema", "Manifest + CSV schema", async () => {
      const raw = JSON.parse(JSON.stringify(FIXTURE_MANIFEST)) as Record<string, unknown>;
      (raw["matter"] as Record<string, unknown>)["slug"] = slug;
      raw["idempotency_key"] = `selftest-${stamp}`;
      const parsed = manifestSchema.parse(raw) as Manifest;
      const docketRows = parseCsv(FIXTURE_DOCKET_CSV).rows.map((r) => docketRow.parse(compact(r)));
      const partyRows = parseCsv(FIXTURE_PARTIES_CSV).rows.map((r) => partyRow.parse(compact(r)));
      return [
        `manifest v${parsed.contract_version}, ${docketRows.length} docket rows, ${partyRows.length} party rows`,
        { m: parsed, rows: docketRows, parties: partyRows },
        { docket_rows: docketRows.length, party_rows: partyRows.length, files: parsed.files.length },
      ];
    });

    // ------------------------------------------------ 2. negative checks --
    await runner.step("negative", "Edge-case rejection rules", async () => {
      const uploaded = new Set(m.files.map((f) => f.file_name));
      const clean = validateBatch(m, rows, uploaded);
      assert(clean.length === 0, `golden bundle should validate clean, got ${clean.map((r) => r.code).join(",")}`);

      const missing = validateBatch(m, rows, new Set([...uploaded].slice(1)));
      assert(missing.some((r) => r.code === "file_missing" || r.code === "missing_upload"),
        "a missing upload must be rejected");

      const dupes = validateBatch(m, [...rows, rows[0]!], uploaded);
      assert(dupes.some((r) => r.code.includes("duplicate")), "a duplicate slot must be rejected");

      const badHash = rows.map((r, i) => (i === 0 ? { ...r, sha256: "0".repeat(64) } : r)) as DocketRow[];
      const hashRejects = validateBatch(m, badHash, uploaded);
      const orphan = validateBatch(m, [
        ...rows,
        { ...rows[0]!, entry_number: 999, attachment_number: 1, record_id: "sw-orphan" },
      ] as DocketRow[], uploaded);

      return [
        `clean=0 rejects · missing-upload, duplicate-slot, orphan-attachment all rejected`,
        null,
        {
          clean: clean.length,
          missing_upload: missing.length,
          duplicate_slot: dupes.length,
          bad_hash_totals: hashRejects.length,
          orphan_attachment: orphan.length,
        },
      ];
    });

    // ------------------------------------------------------- 3. create ----
    const created = await runner.step("create", "POST /ingest/batches (auth + staging URLs)", async () => {
      const unauth = await fetch(`${origin}/api/public/ingest/batches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(m),
      });
      assert(unauth.status === 401, `unauthenticated create should 401, got ${unauth.status}`);

      const res = await fetch(`${origin}/api/public/ingest/batches`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": ingestKey },
        body: JSON.stringify(m),
      });
      const body = (await res.json()) as {
        batch_id: string;
        uploads: { docket_csv: string; parties_csv: string; files: { file_name: string; url: string }[] };
      };
      assert(res.status === 201, `create failed: ${res.status} ${JSON.stringify(body)}`);
      return [
        `batch ${body.batch_id} created · 401 enforced for missing key`,
        body,
        { batch_id: body.batch_id, upload_urls: body.uploads.files.length + 2 },
      ];
    });
    const batchId = created.batch_id;

    // ------------------------------------------------------- 4. upload ----
    await runner.step("upload", "Presigned staging uploads", async () => {
      const put = async (url: string, body: BodyInit, type: string) => {
        const r = await fetch(url, { method: "PUT", body, headers: { "content-type": type } });
        assert(r.ok, `staged PUT failed: ${r.status} ${await r.text()}`);
      };
      await put(created.uploads.docket_csv, FIXTURE_DOCKET_CSV, "text/csv");
      createdKeys.add(incomingKey(slug, batchId, "docket.csv"));
      await put(created.uploads.parties_csv, FIXTURE_PARTIES_CSV, "text/csv");
      createdKeys.add(incomingKey(slug, batchId, "parties.csv"));
      for (const f of created.uploads.files) {
        await put(f.url, fixtureBytes(f.file_name) as unknown as BodyInit, "application/pdf");
        createdKeys.add(incomingKey(slug, batchId, f.file_name));
      }
      createdKeys.add(incomingKey(slug, batchId, "manifest.json"));
      return [`${created.uploads.files.length} PDFs + 2 CSVs staged`, null, { objects: createdKeys.size }];
    });

    // ----------------------------------------------------- 5. validate ----
    await runner.step("validate", "Server-side batch validation", async () => {
      const res = await fetch(`${origin}/api/public/ingest/batches/${batchId}/validate`, {
        method: "POST",
        headers: { "x-ingest-key": ingestKey },
      });
      const body = (await res.json()) as { valid?: boolean; rejects?: unknown[]; status?: string };
      assert(res.ok && body.valid !== false, `validation failed: ${JSON.stringify(body)}`);
      return ["bundle validated with 0 rejects", null, body as Record<string, unknown>];
    });

    // ------------------------------------------------------- 6. commit ----
    await runner.step("commit", "Commit → queued", async () => {
      const res = await fetch(`${origin}/api/public/ingest/batches/${batchId}/commit`, {
        method: "POST",
        headers: { "x-ingest-key": ingestKey },
      });
      const body = (await res.json()) as { status?: string };
      assert(res.ok, `commit failed: ${JSON.stringify(body)}`);
      return [`batch status ${body.status ?? "queued"}`, null, body as Record<string, unknown>];
    });

    // -------------------------------------------------------- 7. store ----
    type Prepared = DocketRow & { s3_key?: string; pages?: string[]; sha?: string; bytes?: number };
    const prepared = await runner.step("store", "Hash verification + canonical storage", async () => {
      const out: Prepared[] = [];
      let stored = 0;
      for (const r of rows) {
        const p: Prepared = { ...r };
        if (r.file_name) {
          const staged = await getBytes(incomingKey(slug, batchId, r.file_name));
          assert(staged, `staged object missing for ${r.file_name}`);
          const sha = await sha256Hex(staged);
          assert(sha === r.sha256, `hash mismatch for ${r.file_name}: stored ${sha}, declared ${r.sha256}`);
          assert(isPdf(staged), `${r.file_name} is not a PDF`);
          const key = canonicalPdfKey(slug, r);
          await putBytes(key, staged, "application/pdf");
          createdKeys.add(key);
          p.s3_key = key;
          p.sha = sha;
          p.bytes = staged.length;
          stored++;
        }
        out.push(p);
      }
      return [`${stored} PDFs hash-verified and promoted to canonical keys`, out, { stored }];
    });

    // ------------------------------------------------------ 8. extract ----
    await runner.step("extract", "Text extraction + page-aware chunking", async () => {
      let pages = 0;
      let chunks = 0;
      for (const p of prepared) {
        if (!p.s3_key) continue;
        const bytes = await getBytes(p.s3_key);
        assert(bytes, `canonical object missing: ${p.s3_key}`);
        const parsed = await extractPdf(bytes);
        assert(parsed.pageCount === p.page_count,
          `page mismatch for ${p.file_name}: parsed ${parsed.pageCount}, declared ${p.page_count}`);
        p.pages = parsed.pages;
        pages += parsed.pageCount;
        const text = parsed.pages.filter((t) => t.trim()).join("\n\n");
        if (text.trim()) {
          const tk = canonicalTextKey(slug, p);
          await putText(tk, text, "text/plain; charset=utf-8");
          createdKeys.add(tk);
          chunks += chunkPages(parsed.pages).length;
        }
      }
      assert(pages === m.totals.total_pages,
        `total pages ${pages} != manifest ${m.totals.total_pages}`);
      return [`${pages} pages extracted, ${chunks} chunks prepared`, null, { pages, chunks }];
    });

    // -------------------------------------------------------- 9. write ----
    const written = await runner.step("write", "Corpus write (entries, documents, parties, chunks)", async () => {
      const entries = rows
        .filter((r) => r.attachment_number === 0)
        .map((r) => ({
          docket_source: r.docket_source,
          entry_number: r.entry_number,
          entry_label: r.entry_label,
          filed_date: r.filed_date,
          description: r.description ?? "",
          doc_type: r.doc_type ?? null,
          source_docket_number: m.dockets.find((d) => d.source === r.docket_source)?.docket_number ?? null,
        }));
      const documents = prepared.map((p) => {
        const pages = p.pages ?? (p.availability === "text_only" ? [p.description ?? ""] : []);
        const chunks = pages.some((t) => t.trim()) ? chunkPages(pages) : [];
        return {
          docket_source: p.docket_source,
          entry_number: p.entry_number,
          attachment_number: p.attachment_number,
          entry_label: p.entry_label,
          title: p.document_title ?? p.description ?? p.entry_label,
          doc_type: p.doc_type ?? null,
          is_sealed: p.is_sealed === true || p.availability === "sealed",
          record_id: p.record_id ?? null,
          availability_status: p.availability,
          expected_sha256: p.sha256 ?? null,
          sha256: p.sha ?? null,
          byte_count: p.bytes ?? null,
          page_count: p.page_count ?? null,
          s3_bucket: p.s3_key ? MATTERS_BUCKET : null,
          s3_key: p.s3_key ?? null,
          hash_verified: Boolean(p.sha),
          text_status: chunks.length ? "extracted" : p.availability === "text_only" ? "text_only" : "no_text",
          source_docket_number: m.dockets.find((d) => d.source === p.docket_source)?.docket_number ?? null,
          chunks,
        };
      });
      const res = await rpc<Record<string, number | string>>("etl_selftest_write", {
        p: { matter: m.matter, entries, documents, parties },
      });
      return [
        `${res["entries"]} entries · ${res["documents"]} documents · ${res["chunks"]} chunks · ${res["parties"]} parties`,
        res,
        res as Record<string, unknown>,
      ];
    });

    // -------------------------------------------------------- 10. embed ---
    await runner.step("embed", "Titan embeddings (amazon.titan-embed-text-v2:0, 1024d)", async () => {
      const { embedText } = await import("@/lib/pile/titan.server");
      const pending = await rpc<{ chunk_id: string; content: string }[]>("etl_selftest_chunks", { p_slug: slug });
      assert(pending.length > 0, "no chunks were produced to embed");
      const vectors: { chunk_id: string; embedding: string }[] = [];
      for (const chunk of pending) {
        const embedding = await embedText(chunk.content);
        assert(embedding, `Titan embed failed for chunk ${chunk.chunk_id}`);
        vectors.push({
          chunk_id: chunk.chunk_id,
          embedding: `[${embedding.map((x) => x.toFixed(6)).join(",")}]`,
        });
      }
      const dims = vectors[0] ? JSON.parse(vectors[0].embedding).length : 0;
      assert(dims === 1024, `expected 1024-dim vectors, got ${dims}`);
      const n = await rpc<number>("etl_selftest_embed", { p_slug: slug, p_vectors: vectors });
      return [`${n} chunks embedded at ${dims} dimensions`, null, { chunks: n, dims }];
    });

    // ------------------------------------------------------- 11. verify ---
    await runner.step("verify", "Corpus assertions", async () => {
      const s = await rpc<Record<string, unknown>>("etl_selftest_stats", { p_slug: slug });
      const num = (k: string) => Number(s[k] ?? 0);
      assert(s["matter_exists"] === true, "matter row was not created");
      assert(num("documents") === m.totals.document_slots,
        `documents ${num("documents")} != declared slots ${m.totals.document_slots}`);
      assert(num("documents_with_pdf") === m.totals.pdf_files,
        `stored PDFs ${num("documents_with_pdf")} != declared ${m.totals.pdf_files}`);
      assert(num("hash_verified") === m.totals.pdf_files, "not every stored PDF is hash-verified");
      assert(num("duplicate_slots") === 0, "duplicate document slots detected");
      assert(num("unordered_entries") === 0, "entries are missing display ordering");
      assert(num("max_entry_number") < 900000, "synthetic entry numbering detected");
      assert(num("chunks") > 0 && num("unembedded_chunks") === 0, "chunks are missing embeddings");
      const bySource = s["entries_by_source"] as Record<string, number>;
      assert(Object.keys(bySource).length === m.dockets.length,
        `expected ${m.dockets.length} docket sources, got ${Object.keys(bySource).join(",")}`);
      return [
        `${num("documents")} documents · ${num("documents_with_pdf")} PDFs · ${num("chunks")} chunks · 0 unembedded · 0 duplicates`,
        null,
        s,
      ];
    });

    ok = runner.steps.every((s) => s.status !== "fail");
    void written;
  } catch {
    ok = false;
  }

  // ----------------------------------------------------------- teardown ---
  let objectsDeleted = 0;
  const objectsFailed: string[] = [];
  let rowCleanup: unknown = null;
  for (const key of createdKeys) {
    try {
      if (await deleteObject(key)) objectsDeleted++;
      else objectsFailed.push(key);
    } catch {
      objectsFailed.push(key);
    }
  }
  try {
    rowCleanup = await rpc("etl_selftest_purge", { p_slug: slug });
  } catch (e) {
    rowCleanup = { error: e instanceof Error ? e.message : String(e) };
  }
  runner.steps.push({
    id: "cleanup",
    label: "Teardown (throwaway matter + staged objects)",
    status: objectsFailed.length ? "fail" : "pass",
    ms: 0,
    detail: objectsFailed.length
      ? `${objectsDeleted} objects deleted, ${objectsFailed.length} left behind`
      : `${objectsDeleted} objects deleted, corpus rows purged`,
    data: { objects_deleted: objectsDeleted, objects_failed: objectsFailed, rows: rowCleanup },
  });

  const finishedAt = new Date();
  return {
    run_id: stamp,
    slug,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    ok: ok && !objectsFailed.length,
    steps: runner.steps,
    cleanup: { objects_deleted: objectsDeleted, objects_failed: objectsFailed, rows: rowCleanup },
  };
}

export const corpusEndpoint = corpusUrl;
export const slotLabel = slotKey;
