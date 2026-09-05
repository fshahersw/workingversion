# Backfill spec: what to hand me for each new matter

Verified against the live pipeline (`scripts/pipeline/ingest_matter.py`) and the Apple matter that is already `embedded` in the corpus (193 free_recap / 171 pacer_link / 27 text_only documents). Insulin (`insulin-pricing-md-3080`) and Roundup (`roundup-pl-md-2741`) are both still at pipeline stage `new` — empty shells waiting for files.

Per matter you give me **3 files + 1 folder of PDFs**. Nothing else.

## 1. Full docket CSV — `<NAME>_FULL_DOCKET.csv`

One row per document slot (main document = attachment 0, plus one row per attachment). This is the backbone: entries, availability, hashes, page counts, source URLs.

Columns the pipeline actually reads (exact header names, UTF-8, comma-delimited, quoted):

| Column | Meaning |
|---|---|
| `record_id` | export row id, e.g. `0001` |
| `docket_entry` | entry number, e.g. `140` (integer entries; `T5`-style labels also tolerated) |
| `attachment_number` | `0` for the main document, `1..N` for attachments |
| `filed_date_iso` | `YYYY-MM-DD` |
| `docket_description` | full docket text (falls back to `document_type` when blank) |
| `document_label` | `Main Document` / `Attachment N` |
| `document_type` | PACER event type, normalized into our doc-type enum |
| `public_access_status` | **exactly** `FREE_RECAP_PDF_AVAILABLE`, `PACER_LINK_AVAILABLE`, or `NO_PUBLIC_PDF_LINK` |
| `file_name` | standardized filename of the local PDF |
| `page_count_exact`, `size_bytes` | integers |
| `sha256`, `sha1`, `md5` | hashes of the local PDF (sha256 is the verification gate) |
| `recap_pdf_url`, `internet_archive_url`, `courtlistener_document_url`, `pacer_pdf_url`, `pacer_price_usd` | provenance links |

Header note: the Apple export used `public_access_status` and `file_name`; the separate missing-PACER file used `availability_status` / `local_filename`. Only the first spelling is understood — keep the docket CSV on `public_access_status` / `file_name`.

Extra columns (PDF producer metadata, source page, etc.) are harmless and ignored.

## 2. Parties & attorneys CSV — `<NAME>_PARTIES_AND_ATTORNEYS.csv`

One row per party↔attorney relationship. Columns: `party_role`, `party_name`, `representation`, `attorney_name`, `attorney_designations` (`LEAD ATTORNEY` / `ATTORNEY TO BE NOTICED` — drives the `is_lead` flag), `attorney_phone`, `attorney_fax`, `attorney_email`, `attorney_address_and_firm` (firm is parsed out of this block), `attorney_full_details`.

## 3. Case metadata JSON — `<NAME>_CASE_METADATA.json`

Flat object. Keys consumed: `courtlistener_caption`, `assigned_judge`, `referred_magistrate_judge`, `cause`, `nature_of_suit`, `jury_demand`, `jurisdiction_type`, `courtlistener_docket_id`, `courtlistener_url`, `pacer_case_id`, `pacer_stable_docket_url`, `date_filed` (display form like `June 7, 2024`). The inventory totals (`local_pdf_count`, `local_pdf_total_pages`, `document_slot_count_...`) are used as the reconciliation target in the verify gate — include them.

File naming: I auto-discover them by keyword, so the names must contain `FULL_DOCKET` (.csv), `PARTIES` (.csv), and `METADATA` (.json).

## 4. The PDFs

Filenames must be one of:

```text
0133. (11-19-2025) NOTICE of Voluntary Dismissal....pdf   -> entry 133, main
0140-003. (11-20-2025) (Exhibit).pdf                      -> entry 140, attachment 3
gov.uscourts.njd.550383.140.3.pdf                         -> RECAP naming also accepted
```

Upload path: drag them into the matter's dropzone in the app (they land in `<slug>/incoming/` in the `matters` bucket, and the millisecond prefix the dropzone adds is stripped automatically). A local folder also works if you'd rather I point at a path.

## What I do with it

1. Add the matter slug to `scripts/pipeline/matters.json` (short name + stage) and drop the three export files in `scripts/pipeline/inputs/<slug>/`.
2. Run the pipeline: `ledger -> parties -> match -> store -> write -> extract -> embed -> verify`, starting with a `--dry-run` match so you see slot counts, unmatched files, and missing slots before anything is written.
3. `store` verifies every upload's sha256 against the CSV; mismatches are quarantined, never written.
4. `verify` reconciles DB counts against the metadata JSON totals, then flips the matter live for RAG (voyage-law-2, 1024-dim, hybrid RRF search).

## Two things to decide per matter

- **PACER-only documents** (no free PDF): recorded as clickable `pacer_link` rows by default, not purchased. Say the word if you want them fetched.
- **Text-only entries** (e.g. text orders, `NO_PUBLIC_PDF_LINK`): ingested as text-only records so the docket text is still searchable — same as Apple's 27.

## Scale note

Roundup is ~31k documents in the old registry. Same format works, but I'd stage it in batches (`--limit`) and run extract/embed in the background rather than in one pass.
