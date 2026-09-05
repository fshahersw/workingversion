# Backfill the registry from what's already in S3

You're right — most of the "missing" data is already sitting in object storage. I inspected both buckets and the registry to confirm exactly what exists where.

## What's actually there (verified)

**Registry today (release `b2a-…`)**
- 4,159 matters, 29,340 docket entries, 13,971 documents — documents exist for only 16 MDL masters.
- `docket_entries` carries only `entry_number` (text) + `description`. No date, no page count, no attachment number, no document link.
- `parties` (503) and `counsel_appearances` (878) exist for ~57 target matters only.
- 21,454 open review records, mostly `missing_receipt_path`.

**`kb-staging` bucket (not yet ingested)**
- `catalog/documents_by_master/*.json` — per-document records with `entry_date_filed`, `page_count`, `attachment_number`, `document_type`, `doc_category`, `is_sealed`, `pacer_doc_id`, CourtListener URL, sha1 — keyed by `doc_uid`, the **same identifier the registry already stores on `documents`**.
- `catalog/matters.json` + `matter_graph/dockets.json` — 2,122 dockets with judge, filed/terminated dates, firms, roles, MDL master link, CL URL.
- `catalog/parties_by_docket/*.json` (59), `attorneys.json`, `firms.json`, `judges.json`, `opinions.json`, citation graph.
- `recap-pdfs/<docket_id>/gov.uscourts.<court>.<case>.<entry>.<att>.pdf` — **1,564 docket folders of actual PDFs**, versus 16 matters with documents in the registry today.
- `bulk/parquet/*` — full CourtListener bulk (dockets, opinions, citations, courts, judges) for anything the catalog doesn't cover.

**`FORAWS` bucket** — only `batch1/objects/sha256/…`, the 13,971 blobs already registered. That's why the app looks half-empty: the loader ingested `FORAWS` only.

## The fix, in order of value per effort

### Phase 1 — Enrichment sidecar (biggest win, no re-ingest)
Load the S3 catalog into a new `enrich` schema in the registry, joined on identifiers the registry already has:

| New table | Source | Joins on | Fills |
|---|---|---|---|
| `enrich.document_meta` | `catalog/documents_by_master/*.json` | `doc_uid` | filing date, page count, attachment number, category, sealed, PACER/CL links |
| `enrich.entry_meta` | same, rolled up per entry | `matter_id` + `entry_number` | **real entry dates** and numeric ordering |
| `enrich.matter_meta` | `catalog/matters.json`, `matter_graph/dockets.json` | `court` + `docket_number` | judge, filed/terminated, firms, MDL master link, CL URL |
| `enrich.party` / `enrich.counsel` | `parties_by_docket/*.json`, `attorneys.json`, `firms.json` | docket id | parties and counsel for dockets that currently show none |
| `enrich.pdf_object` | `recap-pdfs/` listing | docket id + entry + attachment | a downloadable PDF for ~1,564 matters instead of 16 |

Sidecar tables mean zero risk to the canonical registry and no waiting on the next loader release. If a later release supplies the same fields natively, the app prefers registry values and falls back to `enrich`.

### Phase 2 — App reads the enriched data
- Filing register shows **real dates**, correct numeric ordering, page counts, attachment children grouped under their parent entry, sealed/unavailable badges.
- Documents tab resolves PDFs from either bucket (`FORAWS` or `kb-staging`) — the presigner gets multi-bucket support.
- Parties/counsel panels populate for the newly covered dockets; the "not in this release" empty state only shows where it's genuinely true.
- Matter header gains judge, firms of record, MDL master/member links.
- Corpus health gains a "backfill coverage" row: registry-native vs enriched vs still missing.

### Phase 3 — Close the real gaps
- **Truncation**: master dockets capped near 2,000 entries — reload full dockets from `bulk/parquet/dockets.parquet`.
- **Documents for 2,171 matters with zero entries** — pull their entries from the bulk parquet.
- **Review queue**: reconcile `missing_receipt_path` against objects that verifiably exist in `FORAWS`, and stop marking rows `verified` while their review record is open.
- **Text layer**: no document currently has extracted text; OCR/text extraction is what unlocks real RAG over filings (separate track, worth scoping after Phase 1–2).

## How the backfill runs

A one-shot ingest job I write in this project: a protected server route that streams the S3 JSON, normalizes it, and upserts into `enrich.*` in batches, resumable per file, with a progress row per source file. Re-running is idempotent (upsert on natural key). You trigger it from the Corpus page; it reports rows loaded and files skipped.

If you'd rather this run in your existing Python loader pipeline instead of in the app, say so — I'd then produce the DDL plus the transform spec and the app would only consume the tables.

## Technical notes

- Registry access stays through the service key on the server side; nothing new is exposed to the browser.
- `doc_uid` (`<docket_id>-<entry>-<seq>`) is the reliable join key between registry documents and the S3 catalog; `court` + `docket_number` is the key for matters; the recap PDF filename encodes court, PACER case, entry, and attachment.
- Parquet extraction (Phase 3) runs through DuckDB against `bulk/parquet/` rather than the 54 GB CSV archives.
- Sidecar tables get indexes on their join keys so the filing register stays server-paginated at current speed.

## Scope of the first build

Phase 1 + Phase 2 (enrichment load, then wire the UI to it). Phase 3 after we see coverage numbers on the Corpus page.
