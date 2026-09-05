# Continue Insulin MDL 3080 fetch + merge with CourtListener API key

## Context
- JPML panel docket `67376316` converted: 721 rows, 53 PDFs.
- D.N.J. transferee docket `67665081` converted: 1,893 rows, 1,187 PDFs.
- Combined: ~2,614 document slots, 1,240 downloadable PDFs.
- Parties CSV already scraped and merged from both docket party pages.
- Downloads were moved to `/tmp/cl/downloads/insulin-pricing-md-3080/` to avoid repo commit-size limits.
- Metadata JSON and final merged ledger have not been created yet.
- Pipeline has not run yet.

## Goal
Use the provided CourtListener API key to finish downloading any remaining PDFs, then merge both docket ledgers, generate metadata, and run the full ingestion pipeline for `insulin-pricing-md-3080`.

## Steps

### 1. Accept the API key
- User adds `COURTLISTENER_API_TOKEN` to project secrets.
- Update `scripts/backfill/fetch_courtlistener.py` to read the token from env and use it for all CourtListener REST calls.
- Update `scripts/pipeline/fetch_pdfs.py` so it can send the token when hitting `storage.courtlistener.com` or the IA fallback if needed.

### 2. Finish PDF downloads
- Re-run the downloader against both ledgers with the authenticated token.
- Use slightly higher concurrency and shorter backoff now that rate limits are better.
- Retry the ~3 transient failures and any stragglers.
- Confirm all 1,240 PDFs pass SHA-1/size verification; quarantine any that still fail.
- Copy the completed download directory into `scripts/pipeline/downloads/insulin-pricing-md-3080/` for the pipeline, or point the pipeline at `/tmp/cl/downloads/...` — whichever avoids repo bloat.

### 3. Merge ledgers and metadata
- Run `scripts/pipeline/convert_cl_export.py` final pass if needed to ensure both ledgers are up to date.
- Concatenate the two canonical ledgers into one `INSULIN_FULL_DOCKET.csv` under `scripts/pipeline/inputs/insulin-pricing-md-3080/`.
- Reconcile totals: total slots, PDFs, pages, sealed/PACER-only/text-only rows.
- Generate `INSULIN_CASE_METADATA.json` from the transferee docket page (`67665081`) as the primary source, including:
  - caption, judge, magistrate, cause, nature of suit, jury demand, jurisdiction, filing date, PACER case id;
  - panel docket alias `67376316`;
  - reconciliation totals from the merged ledger.
- Confirm `INSULIN_PARTIES_AND_ATTORNEYS.csv` is already in the inputs folder.

### 4. Run ingestion pipeline
- `ledger → parties → match → store → write → extract → embed → verify` for `insulin-pricing-md-3080`.
- Point `--local-dir` at the download folder so SHA-256/MD5/page counts and file paths are correct.
- After extraction, mark matter live and run Voyage `voyage-law-2` 1024-dimensional embeddings.
- Run the verify step to confirm row counts and embedding coverage.

### 5. Smoke-test in app
- Open the Matters page for `insulin-pricing-md-3080` and run one RAG query to confirm sources render and citations scroll correctly.

## Decisions to confirm
1. Should the finished download folder live inside the repo under `scripts/pipeline/downloads/`, or stay outside at `/tmp/cl/downloads/` and be symlinked/pointed to? (The repo commit failed at 15 MB, and 1,240 PDFs will be much larger.)
2. Do you want me to re-fetch parties/metadata through the authenticated REST API for cleaner data, or use the already-scraped HTML versions?
