# Backfill the missing documents into the corpus database

Today the corpus database holds **13,971 documents** and **29,340 docket entries** across 4,159 matters. Object storage already holds far more: a master catalog (`catalog/documents.json`, 47 MB, every document with dates, page counts, categories, PACER links) and **100,000+ staged PDFs** across roughly 1,500 dockets. This plan moves that content into the database for the matters the app already shows, so filings, dates, page counts and openable PDFs stop being empty.

## Scope

Pass 1 covers the 4,159 matters already in the registry. Dockets in storage with no matching matter are counted and reported, not loaded — that becomes pass 2 later.

## What gets built

**1. Sidecar tables (you run one SQL file)**

New tables inside the existing `registry` schema, prefixed `enrich_` so nothing your loader pipeline owns is touched or overwritten:

- `enrich_documents` — one row per document: `doc_uid`, matter id, docket id, entry number, attachment number, description, category, page count, file size, sealed/available flags, PACER + CourtListener links, and the S3 bucket/key of the staged PDF when one exists.
- `enrich_entries` — one row per docket entry seen in the catalog: entry number, true filing date, full entry text, document count.
- `enrich_load_runs` — timestamp, counts, and errors for each backfill run, so coverage is auditable.

I will write the SQL file; you paste it into your corpus project's SQL editor once. It is additive only — no changes to `documents`, `docket_entries`, or `matters`.

**2. Backfill loader**

A script I run here that:

- Reads every registry matter plus its `courtlistener_docket_id` alias, building the docket id to matter id map.
- Streams `catalog/documents.json` and keeps only rows whose docket belongs to a registry matter.
- Lists `recap-pdfs/<docket_id>/` in storage and matches each PDF to its document, so every row records exactly where the file lives.
- Upserts into the sidecar tables in batches, keyed on `doc_uid`, so it is safe to re-run and resumable if it stops.
- Writes a run record with per-docket coverage and anything it could not match.

**3. App reads the database instead of storage**

The enrichment overlay added in the last change stays as a fallback, but the primary read path becomes the sidecar tables:

- Filings show real filing dates, page counts and document categories for every backfilled matter.
- Documents attached to entries come from `enrich_documents`, with Open going to the staged PDF (presigned) and falling back to the CourtListener link.
- The Corpus page gains a real coverage line: documents in the registry, documents backfilled, PDFs staged, dockets still unmatched.

## Technical notes

- Join key throughout is `doc_uid` (`<docket_id>-<entry>-<seq>`) plus `courtlistener_docket_id` from `matter_aliases`, both already verified against live data.
- Storage reads use the existing SigV4 presigner (`src/lib/s3.server.ts`) with ranged GETs so the 47 MB catalog is streamed, not buffered.
- Writes go through PostgREST with the corpus service key; keeping tables in `registry` avoids changing your project's exposed-schema setting.
- App changes land in `src/lib/corpus.server.ts` (sidecar loaders take priority over the S3 overlay), `src/lib/enrich.server.ts` (fallback only), and the matter/corpus UI for the new counts.
- Expected runtime: a few minutes for the catalog pass, longer for PDF listing across ~1,500 dockets; the loader logs progress per docket.

## Order of work

1. Deliver the SQL file and confirm you have run it.
2. Run the backfill, report matched/unmatched counts.
3. Switch the app read path to the sidecar tables and update the Corpus coverage panel.
