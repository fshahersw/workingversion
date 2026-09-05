# Apple file set analyzed — canonical ingest format + schema amendments

## What the five files contain (all cross-verified)

**`APPLE_MDL_FULL_DOCKET.csv`** — the full docket inventory: 391 rows × 33 columns.
- 292 main documents + 99 attachments across entries **1–292 with zero gaps**; every entry has an attachment-0 main row.
- Per row: ISO + display dates, full docket description, document label (`Main Document` / `Attachment N`), PACER event type, standardized filename, availability status, **exact page count**, **sha256 + sha1 + md5**, PDF producer/creation metadata, and four source URLs (RECAP, Internet Archive, CourtListener, PACER) with PACER price.
- Availability triage is pre-computed: **193 FREE_RECAP** (free CourtListener PDF) · **171 PACER_LINK** (PACER-only) · **27 NO_PUBLIC_PDF_LINK**.

**`APPLE_MDL_MISSING_PACER_FILES.csv`** — the 30 documents you don't have locally. Its (entry, attachment) keys are **exactly** the full docket's 30 no-local PACER_LINK rows — set equality confirmed. All 30 carry direct `ecf.njd.uscourts.gov` document URLs; 7 have prices (max $3.00), 23 show "price not displayed".

**`APPLE_MDL_PARTIES_AND_ATTORNEYS.csv`** — 474 party↔attorney relationship rows: **82 distinct parties, 186 distinct attorneys, 86 lead attorneys**. `attorney_designations` carries `LEAD ATTORNEY` / `ATTORNEY TO BE NOTICED` flags; firm name is embedded in the address block (parseable — Seeger Weiss LLP appears 17×); email column is empty throughout.

**`APPLE_MDL_CASE_METADATA.json` / .csv** — bibliographic record: Judge Neals (+ Magistrate Wettre), cause 15:2 Antitrust, NOS 410, jury demand, jurisdiction, CourtListener docket id 68869775, PACER case id 550383, and inventory totals that **reconcile to the row/byte/page** with the CSVs: 391 slots = 334 local PDFs (6,094 pages, 232.8 MB) + 30 PACER-only + 27 no-link.

## Why this validates the rebuild

- **Sorting dies at the source**: integer entries 1–292, no gaps, no "T5"-style labels in this docket.
- **Trust-but-verify ingest**: every local file arrives with a precomputed sha256 — the pipeline verifies your upload against the CSV instead of blindly hashing.
- **Deterministic slot matching**: 100% of filenames follow `NNNN. (MM-DD-YYYY) Title.pdf` (mains) and `NNNN-NNN. (…)` (attachments) — storage keys become derivable, matching is unambiguous.
- **The 27 no-link rows are not missing data**: 26 are `MDL TEXT ORDER` entries — the docket text *is* the document. They belong in the corpus as text-only records so RAG can answer "what did the court order on Oct 15?" without a PDF.
- **Leadership structure is recoverable**: lead-attorney designations + firm parsing give the workspace right rail a real "Leadership" section (e.g. Seeger Weiss's role is explicit in the data).

## Work plan

### 1. Small schema amendments (`corpus` v2.1)
- `documents`: add `availability_status` (`free_recap` / `pacer_only` / `text_only` / `local`), `recap_url`, `pacer_url`, `archive_url` (the existing `courtlistener_url`, `source`, `source_url` stay).
- `docket_entries`: add `entry_label` already exists; add nothing — `page_count`, `entry_type`, `description` all map directly.
- `counsel`: add `is_lead boolean`, `phone`, `address` (raw block), keep flat shape.
- `matters`: populate judge/magistrate, cause, NOS, jury demand, `courtlistener_id`, `pacer_case_id`, URLs from the metadata JSON.

### 2. Pipeline upgrades (`scripts/pipeline/ingest_matter.py`)
- **Replace the ledger parser** — it currently expects the old `docket_sheet_number/date/title` columns. New canonical parser for this 33-column format: entries + attachment slots + availability + hashes + page counts + URLs in one pass.
- **Parties/counsel stage** — new stage parsing the 474-row CSV: dedupe to 82 parties, 186 attorneys, parse firm from the address block, carry `LEAD ATTORNEY` into `is_lead`.
- **Hash-verified store stage** — when a file drops into `incoming/`, match by filename → verify sha256 against the CSV → only then write the row. Mismatch quarantines the file and flags the row.
- **doc_type normalization map** — ~140 distinct PACER event-type strings in this docket ("Letter", "Notice of Appearance", "Order", "MDL Transfer Order (in)", …) mapped to the workspace enum (order / motion / brief / exhibit / declaration / transcript / notice / correspondence / other). Raw value preserved alongside.
- **Text-only handling** — the 27 no-link entries get document rows with `availability_status='text_only'`, no PDF; their docket text feeds the extract/embed stages directly.
- **Verify gate upgraded** — a matter goes live when: CSV row count == DB document count, every local-file hash verified, page counts match pypdf, and the remaining gaps are exactly the declared PACER-only set.

### 3. The 30 PACER-only documents — decision
Default: record them as `pacer_only` rows with their direct ECF URLs so the ledger is complete and clickable, **without** purchasing. If you want them in the corpus, that needs PACER credentials (yours — I'd request them as secrets) and a small fetch stage; rough cost is pages × $0.10 capped at $3/doc (7 priced docs total $X, 23 unpriced). Say the word and I'll add the fetch stage; otherwise they stay as link-outs.

### 4. Ingest order for Apple
1. Apply schema amendments (v2.1).
2. Copy the three CSVs + JSON into `scripts/pipeline/inputs/apple-smartphone-md-3113/` (they're small — no bucket needed).
3. Run `ledger` + `parties` stages → 292 entries, 391 slots, 82 parties, 474 counsel rows visible in the workspace immediately.
4. You drop the 334 PDFs into the workspace dropzone (or a local folder) → `match → store (hash-verified) → extract → embed (voyage-law-2) → verify`.
5. Verification report against the metadata JSON's own totals (334 files / 6,094 pages / 232.8 MB) — the matter goes live only when it matches.

## Technical notes
- No old-registry data anywhere; these files are the sole source.
- The 2 empty `docket_description` rows (entries 9–10, both Notices of Appearance) get their description from `document_type` instead.
- Firm parsing strips the "Counsel Not Admitted to Usdc-Nj Bar," prefix and trailing city/state before extraction.
- Insulin and Roundup: when you export the same file set for those dockets, the same parser ingests them unchanged.
