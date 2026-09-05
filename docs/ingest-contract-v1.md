# Corpus ETL ingest contract v1

Automated pipeline for getting a matter's dockets, PDFs, metadata, parties and
embeddings into the corpus with zero filename guessing.

**Governing rule:** the manifest is authoritative. Filenames are opaque lookup
keys, matched exactly. No regex is ever applied to a filename unless the batch
explicitly sets `batch.filename_inference: true` (legacy fallback, off by
default and never used to *derive* identity — only to suggest one).

## 1. Bundle shape

```text
manifest.json          # required, JSON, contract_version "1.0"
docket.csv             # required, one row per document slot
parties.csv            # optional, one row per attorney/party pair
<file_name>.pdf        # every file declared in docket.csv, PDF 1.x-2.x only
```

Schemas: `schemas/ingest-manifest-v1.json`, `schemas/ingest-docket-v1.csv-spec.md`.
Golden sample: `samples/ingest/golden/`.

## 2. Identity model

A document is identified by
`(matter_id, docket_source, entry_number, attachment_number)` — enforced by a
unique index in the corpus. `docket_source` distinguishes the transferee-court
docket (`main`) from the JPML docket (`jpml`) and any state/appellate docket, so
JPML entry 3 and main entry 3 coexist without numeric offsets.

Storage keys are derived, never uploaded:

```text
matters/<slug>/pdf/<docket_source>/<entry:05d>-<attachment:03d>.pdf
matters/<slug>/text/<docket_source>/<entry:05d>-<attachment:03d>.txt
```

## 3. HTTP flow

All calls require `X-Ingest-Key: <INGEST_API_KEY>`.

| Step | Call | Result |
| --- | --- | --- |
| 1 | `POST /api/public/ingest/batches` with `manifest.json` as the body | `201` + `batch_id` + presigned S3 `PUT` URLs for `docket.csv`, `parties.csv` and every declared file (1 h TTL) |
| 2 | `PUT` each file to its presigned URL | objects staged under `<slug>/incoming/<batch_id>/` |
| 3 | `POST /api/public/ingest/batches/:id/validate` | `200 validated`, or `422` with a full reject list. Re-runnable after fixing and re-uploading. |
| 4 | `POST /api/public/ingest/batches/:id/commit` | `queued`; the pipeline runner executes store → write → extract → embed → verify |
| 5 | `GET /api/public/ingest/batches/:id` | live status, stage, counts, rejects |

Re-opening a batch with the same `idempotency_key` for the same matter returns
`409 duplicate_batch` — retries are safe.

## 4. What validation checks

Structural (fail the batch):

- manifest against the v1 schema; unknown fields rejected
- CSV well-formedness, header presence, no duplicate columns, exact field counts
- every field's type/format (ISO dates, hex digests, https URLs, enums)
- `availability` ↔ file rules: a PDF is required for `free_pdf` /
  `locally_supplied` and forbidden for `pacer_link` / `text_only` / `sealed`
- duplicate slots, duplicate `file_name`s, undeclared uploads, missing uploads
- attachments with no main row (`full` mode)
- attachment rows disagreeing with the main row on `filed_date`
- manifest `totals` vs. the actual rows (slots, PDFs, pages, bytes)
- staged object size vs. declared `size_bytes`

Commit-time (per record, recorded as rejects, batch continues):

- SHA-256 of the stored object vs. declared `sha256`
- PDF magic bytes + parseability, real page count vs. declared `page_count`
- encrypted / zero-page / zero-byte PDFs
- slot already occupied by a *different* hash (never silently overwritten)

## 5. Edge cases and how they resolve

| Case | Behaviour |
| --- | --- |
| Same PDF uploaded twice under different names | `duplicate_file_name` if declared twice; otherwise deduplicated by hash, one stored object, both slots point at it |
| Re-submitting a slot with an identical hash | no-op, counted as `unchanged` |
| Re-submitting a slot with a different hash | stored as a new version; the previous key is retained, the newer becomes current |
| Text/minute order with no PDF | `availability: text_only`, entry created, no document row with a file |
| Sealed entry | `availability: sealed`, `is_sealed=true`, entry visible, no PDF |
| PACER-only paywalled doc | `availability: pacer_link`, link stored, no file expected |
| Attachment arrives before its main row | rejected in `full` mode; in `incremental` mode allowed if the entry already exists |
| Entry number that already exists on another docket | fine — the source discriminates it |
| Non-PDF or corrupt bytes | rejected at commit with `bad_pdf`, nothing written |
| Partial upload / expired presign | file simply missing at validate → `file_missing`, re-upload and re-validate |
| Duplicate batch submission | `409 duplicate_batch` on the idempotency key |

## 6. Local pre-flight

Run the same validation before you send anything:

```bash
python3 scripts/pipeline/validate_bundle.py samples/ingest/golden
```

It reproduces the server's rules exactly (schema, CSV, cross-row, hashes, PDF
page counts) and exits non-zero with a reject table when anything is off.

## 7. Post-ingest wiring

The runner writes docket entries, documents, parties and counsel, extracts text
to `text/`, chunks and embeds with `voyage-law-2` (1024-d), refreshes docket
display ordering (`corpus.refresh_display_order`), and recomputes matter counts —
so the matter workspace, the ledger, the document viewer and RAG retrieval all
reflect the batch as soon as it reports `completed`.
