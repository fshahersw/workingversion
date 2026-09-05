# Steps 1–2: capture the bridge views in source control, replace the dead health SQL

Two safe, additive changes to the corpus database plus the SQL files that define it. No data is touched, no app code behavior changes.

## Step 1 — Capture the six bridge views as one authoritative file

All six `public.corpus_*` views exist in the live database, but only two (`corpus_docket_entries`, `corpus_documents`) have a definition in the repo — the other four were created out of band and can't be rebuilt from source.

New file `supabase/corpus/bridge-views.sql`, idempotent (`CREATE OR REPLACE VIEW`), containing all six definitions exactly as they exist live:

| View | Columns |
|---|---|
| `corpus_matters` | 24 identity/court/pipeline columns |
| `corpus_docket_entries` | entry fields + display/sort columns (moved out of `docket-order-cleanup.sql`) |
| `corpus_documents` | document fields + display/sort columns (same) |
| `corpus_parties` | party_id, matter_id, name, party_type, created_at |
| `corpus_counsel` | counsel_id, matter_id, party_name, attorney, firm, role, created_at |
| `corpus_ingest_runs` | run_id, matter_id, slug, stage, status, detail, started_at, finished_at |

`docket-order-cleanup.sql` keeps its ordering backfill but loses its two view definitions, with a comment pointing at the new file, so there is exactly one place each view is defined.

### Grant tightening (found while reading the live grants)

Right now every one of the six views grants **ALL** privileges — including INSERT, UPDATE, DELETE, TRUNCATE — to both `anon` and `authenticated`. The views run with owner privileges and the underlying `corpus` tables have no RLS policies, so anyone holding the public corpus key can currently write to or truncate the corpus through PostgREST.

Nothing in the app relies on that. Verified read paths:
- `workspace.server.ts` and `agents/corpus-v2.server.ts` — corpus **service** key
- `rag.server.ts` — corpus **service** key
- `corpus.ts` publishable-key client — used only for **storage** signed URLs, never `.from()` on a corpus view

So the file will `REVOKE ALL ... FROM anon, authenticated` and grant `SELECT` to `service_role` only. Read paths are unaffected; the write hole closes.

## Step 2 — Replace `document-health.sql` with a v2 health layer

`document-health.sql` targets the dropped v1 `registry` schema with columns that no longer exist (`doc_uid`, `description`, `doc_source`, `entry_date_filed`, `download_url`); it errors on contact today. `scripts/audit/corpus_scan.py` applies and queries it, so that script is broken too.

Rewrite it against `corpus.*` with defect flags that match how v2 actually works:

**`corpus.v_document_health`** — one row per document, flags:
- no PDF stored (`s3_key` null) and no fetchable URL (`recap_url`/`archive_url`/`courtlistener_url` all null)
- PACER-link-only (paid gap) vs. text-only (docket text is the document) — distinguished via `availability_status`, not treated as defects
- stored PDF missing `page_count`, `byte_count`, or `sha256`
- `expected_sha256` present but `hash_verified` false, or sha256 disagrees
- blank or generic title; attachment title identical to its parent entry text
- orphan document (`docket_entry_id` null); missing `doc_type`
- duplicate `s3_key` across rows
- indexing gaps: `text_status` not `extracted`, or extracted with zero chunks, or chunks with null embeddings
- missing display ordering (`display_label_pretty`/`sort_seq` null)

**`corpus.v_matter_health`** — per-matter rollup: entries, documents, PDF coverage %, extraction %, embedding %, PACER-gap count, each defect count, `pipeline_stage`/`verified_at`, and a health score. Uses `display_number`, so synthetic JPML/blank entry numbers don't create fake gaps.

**`corpus.v_matter_slot_health`** — slot-level (`matter`, `display label`, `attachment`) coverage, the honest docket-completeness measure.

Then update `scripts/audit/corpus_scan.py` to point at `corpus.v_*` with the new column names, and confirm it runs clean against all three matters.

## Verification

1. Apply `bridge-views.sql` to the corpus database; confirm all six views still return rows and grants read `service_role` SELECT only.
2. Re-run the app's read paths (Matters list, a matter workspace, a document view URL, one agent corpus tool, one RAG search) and confirm nothing regressed.
3. Apply the new `document-health.sql`; run `corpus_scan.py` whole-corpus and per-matter, and sanity-check its numbers against the counts already confirmed (Apple 391 docs / 334 with PDF, Insulin 3,019 / 2,368, 0 unembedded chunks).

## Technical notes

- Both files run against the external corpus Postgres via `CORPUS_DB_URL` (`psql -f`), not the Lovable migration tool — that project is not the managed backend.
- Everything is `CREATE OR REPLACE` / `REVOKE` / `GRANT`; no `DROP`, no data mutation, fully re-runnable.
- Roundup has no rows yet, so it will show as an empty matter in the health views — expected, not a defect.
