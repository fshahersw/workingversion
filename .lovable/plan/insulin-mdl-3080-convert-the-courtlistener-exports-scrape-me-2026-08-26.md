# Insulin MDL 3080 — convert the CourtListener exports, scrape metadata, auto-download and ingest

## The two dockets

MDL 3080 lives on two CourtListener dockets, and both belong in the same matter:

- **JPML panel docket** — `67376316` (PACER `jpml.1583968`). 721 document slots (607 main documents, 114 attachments); 53 have a free RECAP PDF URL plus an Internet Archive mirror, the other 668 are docket-text rows with no retrievable PDF.
- **Transferee-court docket** — `67665081` (D.N.J., PACER case `515893`, Judge Brian R. Martinotti), where the substantive filings live. 1,893 document slots (1,343 main documents, 550 attachments) across 1,045 numbered entries plus 298 unnumbered rows; 1,187 have a free RECAP PDF URL (~16,866 pages), 35 are sealed, and the rest are docket-text rows.

Combined: ~2,614 document slots, 1,240 downloadable PDFs. Both dockets merge into the existing `insulin-pricing-md-3080` matter.

Both exports use the raw CourtListener column layout, not the canonical 33-column format the pipeline reads, so they need a conversion step. They carry `sha1` but no `sha256`, and the pipeline's store gate verifies `sha256`.


## Plan

### 1. Converter script — `scripts/pipeline/convert_cl_export.py`

New script that turns a CourtListener docket CSV into our canonical `<NAME>_FULL_DOCKET.csv`:

| Canonical column | Source |
|---|---|
| `record_id` | zero-padded row index |
| `docket_entry` | `docketentry_entry_number` (fallback `recapdocument_document_number`) |
| `attachment_number` | `recapdocument_attachment_number`, blank -> `0` |
| `filed_date_iso` | `docketentry_date_filed` |
| `docket_description` | `docketentry_description` |
| `document_label` | `Main Document` / `Attachment N` |
| `document_type` | `recapdocument_description` (falls back to `recapdocument_document_type`) |
| `public_access_status` | PDF URL present -> `FREE_RECAP_PDF_AVAILABLE`; else `is_sealed`/no link -> `NO_PUBLIC_PDF_LINK`; PACER doc id present but no free copy -> `PACER_LINK_AVAILABLE` |
| `file_name` | `NNNN-AAA.pdf` standardized name |
| `page_count_exact`, `size_bytes` | `recapdocument_page_count`, `recapdocument_file_size` |
| `sha1` | `recapdocument_sha1` |
| `sha256`, `md5` | computed from the downloaded file (step 2) |
| `recap_pdf_url`, `internet_archive_url`, `courtlistener_document_url`, `pacer_pdf_url` | `filepath_local`, `filepath_ia`, CL docket-entry URL, PACER doc-id URL |

### 2. Auto-downloader — `scripts/pipeline/fetch_pdfs.py`

- Downloads each `FREE_RECAP_PDF_AVAILABLE` row from `storage.courtlistener.com`, falling back to the Internet Archive mirror on 403/404.
- Polite concurrency (4-6 parallel, retry with backoff), writes to `scripts/pipeline/downloads/insulin-pricing-md-3080/`.
- Verifies the downloaded bytes against the CSV `sha1` and `file_size`; mismatches are quarantined and reported, never ingested.
- Computes `sha256`/`md5`/real page count and writes them back into the generated FULL_DOCKET CSV, so the pipeline's hash gate has real values.

### 3. Metadata + parties from CourtListener

- Scrape the transferee docket page (`/docket/67665081/insulin-pricing-litigation/`) as the primary source for caption, assigned judge, magistrate, cause, nature of suit, jury demand, jurisdiction type, date filed, PACER case id and stable docket URL -> `INSULIN_CASE_METADATA.json`, with the JPML docket (`67376316`) recorded as the panel-docket alias. Reconciliation totals (slot count, downloaded PDF count, total pages) are computed from the converted CSVs.
- Scrape both parties pages (`/docket/67665081/parties/...` and `/docket/67376316/parties/...`) into one `INSULIN_PARTIES_AND_ATTORNEYS.csv` with the canonical columns (`party_role`, `party_name`, `representation`, `attorney_name`, `attorney_designations`, phone/fax/email, `attorney_address_and_firm`, `attorney_full_details`), de-duplicated on party+attorney.
- All generated files land in `scripts/pipeline/inputs/insulin-pricing-md-3080/` where the pipeline auto-discovers them.

### 4. Run the pipeline

`ledger -> parties -> match (dry-run first) -> store -> write -> extract -> embed -> verify` against `insulin-pricing-md-3080`, pointing `--local-dir` at the download folder. Expected outcome: ~2,614 document rows across both dockets (1,240 with real PDFs and extracted/embedded text, the rest as searchable docket-text records), parties/counsel populated from both dockets, and the matter flipped live for RAG with `voyage-law-2` 1024-dim embeddings.

## Two things to flag

- **298 transferee rows have no entry number** (mostly undocketed RECAP records). They get stable synthetic entry labels via the pipeline's existing non-numeric-label handling, so nothing is dropped.
- **~1,374 of 2,614 slots have no retrievable PDF** (PACER-only, sealed, or never fetched into RECAP). They become text-only/PACER-link records — searchable by docket text, no document body. Purchasing PACER copies is not part of this run.
- **1,240 PDFs is a real download batch** (~17k pages). The downloader runs with polite concurrency against CourtListener and the Internet Archive; extraction and embedding run in the background after storage verifies.


- **This is the panel docket only.** The transferee-court docket for MDL 3080 (D.N.J., where the substantive filings live) is a separate CourtListener docket. I'll ingest this one under `insulin-pricing-md-3080` now; when you export that docket the same converter handles it and the rows merge into the same matter.
- **Only 53 of 721 slots have retrievable PDFs.** The remaining 668 become text-only/PACER-link records — searchable by docket text, but no document body. Purchasing PACER copies is not part of this run.
