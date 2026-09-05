# Automated ETL ingest: exact data contract + endpoint design

Goal: one strict, versioned input contract so a matter can be dropped in and ingested end to end (PDF storage → metadata → docket/document rows → text → chunks → embeddings → live on the matter page) with zero filename-regex guessing.

Core principle: **the manifest is authoritative, filenames are not.** Today `parse_filename` infers entry/attachment from the PDF name with three competing regexes. The new contract requires every PDF to be declared in the manifest by an explicit `file_name` key, so parsing is an exact string lookup. Filename inference stays only as an opt-in fallback (`"filename_inference": true`) for legacy drops.

## 1. Submission bundle (per matter, per batch)

```text
<slug>/
  manifest.json                 ← required, contract v1
  docket.csv                    ← required, one row per document slot
  parties.csv                   ← optional
  pdf/  <files declared in docket.csv>
```

- Encoding: UTF-8 (BOM tolerated). CSV: RFC 4180, comma-delimited, quoted, `\n` or `\r\n`.
- Dates: `YYYY-MM-DD` only (ISO). No `June 7, 2024` anywhere except a display-only field.
- Booleans: `true`/`false`. Empty means null, never `"NULL"`/`"N/A"`.
- Slug: `^[a-z0-9]+(-[a-z0-9]+)*$`.

## 2. `manifest.json`

| Field | Type | Rule |
|---|---|---|
| `contract_version` | string | must be `"1.0"` |
| `matter.slug` | string | slug pattern; created if unknown |
| `matter.short_name`, `matter.caption`, `matter.docket_number`, `matter.court` | string | required for a new matter |
| `matter.mdl_number` | string \| null | |
| `matter.judge`, `magistrate_judge`, `cause`, `nature_of_suit`, `jury_demand`, `jurisdiction_type` | string \| null | |
| `matter.date_filed` | date | ISO |
| `matter.courtlistener_docket_id`, `pacer_case_id` | integer \| null | |
| `matter.courtlistener_url`, `pacer_url` | url \| null | https only |
| `dockets[]` | array | one per docket feeding the matter: `{ "source": "main" \| "jpml" \| "state" , "docket_number", "courtlistener_docket_id" }` — replaces the 900000 magic-number namespacing |
| `batch.mode` | enum | `full` (batch is the whole docket) \| `incremental` (adds/updates only) |
| `batch.filename_inference` | bool | default `false` |
| `totals` | object | `document_slots`, `pdf_files`, `total_pages`, `total_bytes` — reconciliation gate |
| `idempotency_key` | string | client-generated; a repeat submit returns the original run |

## 3. `docket.csv` — one row per document slot

Slot identity = (`docket_source`, `entry_number`, `attachment_number`). Attachment 0 is the main document and also defines the docket entry.

| Column | Type | Required | Notes |
|---|---|---|---|
| `docket_source` | enum `main`/`jpml`/`state` | yes | must match a `dockets[].source` |
| `entry_number` | integer ≥ 0 | yes | real number only |
| `entry_label` | string | yes | display label as printed (`140`, `T5`, `JPML 12`) |
| `attachment_number` | integer ≥ 0 | yes | 0 = main |
| `filed_date` | date | yes | ISO |
| `description` | text | yes for att 0 | full docket text |
| `document_title` | text | no | falls back to description |
| `document_type` | string | no | PACER event type; classifier hint |
| `doc_type` | enum | no | if given, must be one of the 21 corpus doc types; else classifier decides |
| `availability` | enum | yes | `free_pdf` \| `pacer_link` \| `text_only` \| `locally_supplied` \| `sealed` |
| `file_name` | string | required when availability implies a PDF | exact name of a file in `pdf/`; unique in the batch |
| `page_count` | integer | required with a PDF | verified against the PDF |
| `size_bytes` | integer | required with a PDF | verified |
| `sha256` | 64 hex | required with a PDF | **verification gate** |
| `sha1`, `md5` | hex | no | |
| `is_sealed` | bool | no | default false |
| `recap_pdf_url`, `internet_archive_url`, `courtlistener_document_url`, `pacer_pdf_url` | url | no | provenance |
| `pacer_price_usd` | decimal | no | |
| `record_id` | string | no | client row id, echoed in errors |

## 4. `parties.csv`

`party_role`, `party_name` (required), `representation`, `attorney_name`, `attorney_designations` (`LEAD ATTORNEY` / `ATTORNEY TO BE NOTICED`), `attorney_phone`, `attorney_fax`, `attorney_email`, `firm_name`, `firm_address`, `attorney_full_details`.

Change from today: `firm_name` and `firm_address` are separate columns, so the fragile `parse_firm` address/phone regex becomes a fallback used only when `firm_name` is absent.

## 5. PDF files

- `application/pdf`, magic bytes `%PDF-`, max 500 MB per file, must open and report a page count.
- Names are opaque: any UTF-8 name matching the `file_name` cell. No date/entry encoding required.
- Canonical storage keys are derived from the manifest, never the upload name:
  `matters/<slug>/pdf/<source>/<entry:05d>-<att:03d>.pdf`, text at `.../text/<source>/<entry:05d>-<att:03d>.txt`.

## 6. Endpoints (TanStack server routes, `src/routes/api/public/ingest/*`)

All require `Authorization: Bearer <INGEST_API_KEY>`; validated with Zod; all responses JSON.

| Route | Purpose |
|---|---|
| `POST /batches` | body = `manifest.json`. Validates contract, creates `ingest_batches` row, returns `batch_id` + presigned PUT URLs for every declared file (upload straight to `matters/<slug>/incoming/<batch_id>/`). |
| `PUT /batches/:id/docket` and `/parties` | upload the CSVs (or inline rows for API-native clients). |
| `POST /batches/:id/validate` | dry run: schema errors, unknown/duplicate slots, files declared but not uploaded, files uploaded but not declared, hash/page/size mismatches, totals reconciliation. Returns a per-row error list keyed by `record_id`. Nothing is written. |
| `POST /batches/:id/commit` | runs the pipeline stages asynchronously; returns immediately with the run id. |
| `GET /batches/:id` | stage-by-stage status, counts, per-row rejects, verify gates. |
| `POST /webhooks/ingest-complete` (optional) | callback to the submitting system. |

Commit stages (same order as today, made server-side and resumable): `validate → store → entries → documents → parties → extract → chunk → embed → order → verify`.

## 7. Edge cases the endpoint must handle explicitly

- **Duplicate slot in one batch** → hard reject with both `record_id`s.
- **Re-submitting an existing slot** → upsert; PDF replaced only if sha256 differs, old object kept under `quarantine/`.
- **Hash mismatch** → file quarantined, row rejected, batch continues.
- **Declared PDF never uploaded** → row lands as `pacer_link`/`text_only` if declared so, otherwise rejected.
- **Uploaded file not in the manifest** → rejected list (never silently ingested).
- **Non-numeric entry labels** → `entry_number` from the client plus `entry_label` for display; the 900000 offset is retired in favour of `docket_source`.
- **Encrypted / image-only / zero-page PDFs** → stored, `text_status='no_text'`, flagged for OCR, never silently zero-chunk.
- **Text-only and sealed entries** → docket text chunked and embedded so it stays searchable.
- **Partial embedding failure (Voyage 429/5xx)** → retried with backoff; batch stays `embedding`, resumable.
- **Concurrent batches for one matter** → per-matter advisory lock; second batch queues.
- **Totals mismatch vs manifest** → verify gate fails, matter not flipped live.

## 8. Database additions (corpus schema)

- `corpus.docket_entries.docket_source` already exists; add `source_docket_number`.
- New `corpus.ingest_batches` (batch_id, matter, contract_version, mode, idempotency_key, status, counts, submitted_by, timestamps) and `corpus.ingest_rejects` (batch_id, record_id, slot, code, message).
- Unique constraint on (`matter_id`, `docket_source`, `entry_number`, `attachment_number`).

## 9. Deliverables

1. `docs/ingest-contract-v1.md` — this contract, publishable to whoever produces the exports.
2. `schemas/ingest-manifest-v1.json` + `schemas/docket-row-v1.json` — JSON Schema, plus a Zod mirror in `src/lib/ingest/schema.ts` used by the endpoint.
3. `scripts/pipeline/validate_bundle.py` — same validation runnable locally before submission.
4. The endpoints above, sharing one stage engine with `ingest_matter.py` so CLI and API behave identically.
5. Golden-sample bundle (10 slots incl. attachment, text-only, PACER-only, sealed) used as a regression test.

## Decided

1. **Migrate the existing matters onto the new `docket_source` model, in the same change.** Apple and Insulin currently encode the JPML panel docket as `entry_number >= 900000`. The migration is additive and reversible:
   - Snapshot `corpus.docket_entries` / `corpus.documents` (entry_number, entry_label, docket_source, display_number, sort_seq, s3_key) to a timestamped backup table before touching anything.
   - Add `source_docket_number` and backfill `docket_source` from the already-populated column (it is set for every row today via `docket-order-cleanup.sql`), then set `entry_number` to the *real* docket number (`entry_number - 900000` for JPML rows) so the 900000 offset disappears while `docket_source` keeps the two dockets apart.
   - Add the unique constraint on (`matter_id`, `docket_source`, `entry_number`, `attachment_number`) only after a duplicate pre-check returns zero rows; abort otherwise.
   - Re-run `corpus.refresh_display_order` per matter and diff entry/document/chunk counts and display labels before and after. Counts must match exactly.
   - Storage keys are **not** renamed in this step — existing `s3_key` values stay valid; only new ingests use the `<source>/<entry:05d>-<att:03d>.pdf` layout, and a later optional pass can normalise the old keys.
2. **PDF transfer uses presigned S3 PUT.** `POST /batches` returns one presigned PUT per declared file (15-minute expiry, keyed to `matters/<slug>/incoming/<batch_id>/<file_name>`), so uploads never pass through the Worker and have no request-size ceiling. The endpoint re-reads each object server-side to verify `%PDF-` magic bytes, sha256, byte size, and page count before promoting it to its canonical key. Presigning reuses the existing `presignS3Put` helper in `src/lib/s3.server.ts`.

