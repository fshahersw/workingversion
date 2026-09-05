# Pipeline Observability & ETL Test Suite (owner-only)

A new internal **Pipeline** page, visible and reachable only for `fshaher@seegerweiss.com`, that shows ingestion batch status, corpus health metrics, and a one-click live ETL self-test that ingests the golden bundle into a throwaway matter and deletes it afterward.

## Access control

- A single server-side allowlist (`fshaher@seegerweiss.com`, overridable via an `ADMIN_EMAILS` env var).
- Every pipeline server function runs behind the existing Supabase auth middleware and then checks the verified email from the token claims. A non-allowlisted signed-in user gets a 403 — nothing leaks even if they know the URL.
- The route itself renders an "Access restricted" panel for anyone else, and the sidebar link is hidden unless the signed-in email matches.

## The page: `/pipeline` (sidebar, below Matters)

Three sections.

**1. Ingestion batches**
- Table of recent batches: matter slug, mode, status (created / validating / validated / queued / running / completed / failed), current stage, counts (docket rows, files staged/stored, entries, documents, chunks, embedded), created/completed timestamps, duration.
- Status pills with color tone; auto-refresh every 10s while any batch is not terminal.
- Expand a batch to see its reject list (record id, slot, code, message) and its stored manifest summary.
- Observe only — no retry/cancel actions in this pass.

**2. Corpus health metrics**
- Per-matter cards driven by the existing `corpus.v_matter_health` view: entries, documents, PDF / extract / embed coverage percentages, chunks, unembedded chunks, and gap counters (missing description, missing date, missing PDF, main-entry gaps, orphan entries, generic titles).
- Totals strip across all matters, plus a storage line (documents with an S3 key vs. without).
- Freshness indicator: newest `fetched_at` / `verified_at` per matter.

**3. ETL self-test (live round-trip)**
- One button, behind a confirm dialog, that runs the real contract-v1 path against a throwaway slug (`selftest-<timestamp>`), never touching real matters:
  1. auth check (rejects a bad ingest key, accepts the real one)
  2. create batch → presigned PUTs for manifest, docket CSV, parties CSV, and the 4 golden PDFs
  3. upload all staged objects and confirm each is readable (ranged GET size check)
  4. validate → expect 0 rejects and the exact expected counts
  5. negative validation: a mutated manifest (bad hash, page mismatch, missing file, duplicate slot) must produce exactly the expected reject codes
  6. commit → queued
  7. ingest the batch inline (same logic as the runner, invoked server-side for the self-test slug only)
  8. verify assertions: 6 entries across `main` + `jpml` with no synthetic numbers, 7 documents, composite keys unique, 4 PDFs with verified hashes, availability/text-status mapping correct, chunks embedded, display ordering refreshed
  9. teardown: delete the throwaway matter (cascade) and every S3 object under its prefix; final assertion that both are empty
- Live step-by-step results stream into the UI (pass/fail/duration per step, error text on failure), with a "Download report (JSON)" button.
- Teardown always runs, even when an earlier step fails, and the page shows explicitly whether cleanup succeeded.

## Technical notes

- New files: `src/routes/_authenticated/pipeline.tsx` (page, `ssr: false`, own `head()`), `src/components/pipeline/*` (BatchTable, HealthGrid, SelfTestRunner), `src/lib/pipeline.functions.ts` (server fns), `src/lib/pipeline.server.ts` (corpus reads + allowlist), `src/lib/ingest/selftest.server.ts` (round-trip steps + teardown).
- Reads go through the corpus service key server-side against `public.corpus_ingest_batches`, `public.corpus_ingest_rejects`, and health views; a small bridge view for `v_matter_health` is added if the REST bridge for it does not exist yet (service-role select only, no anon/authenticated grants).
- The self-test reuses the existing `src/lib/ingest/*` helpers and the golden bundle in `samples/ingest/golden/`, embedded as a server-side fixture so it works in the deployed worker.
- Embedding inside the self-test uses the same Voyage `voyage-law-2` path; the bundle is tiny (5 chunks), so a run costs a few seconds.
- No backend contract changes, no new public endpoints, and no changes to the existing ingest routes.
