# Ingest the uploaded JPML PDFs (dedup + gap report)

## Entry numbers verified against the CourtListener CSVs

Checked before planning anything: every one of the 843 filenames parses as `<entry>[-<attachment>]. (MM-DD-YYYY) <title>.pdf`, and for all **439** uploads that land on a slot the JPML ledger already knows, the filename's filed date matches the ledger's `filed_date_iso` **439/439, zero mismatches**. Spot-check: `1-1 … 1-9` all read 2023-05-09, matching JPML entry 1 (Motion to Transfer). So your numbering is the real JPML docket entry numbering, not a re-indexed sequence — nothing is off-by-one or shifted.

The 404 uploads not in the ledger are **all attachments** (`attachment > 0`, none are main documents), every one of them hangs off a JPML entry that **does** exist in the ledger, and all 404 filed dates match their parent entry's date. They are exhibits/schedules/proofs of service the CourtListener export simply never enumerated — not a numbering error.

## What the upload contains

843 PDFs in `insulin-pricing-md-3080/incoming/jpml/`. No two files map to the same slot, none are zero-byte.

| Bucket | Count |
| --- | --- |
| Uploads filling a JPML ledger slot that had no PDF | 393 |
| Uploads for a slot we already stored from RECAP | 46 |
| Uploads for attachments absent from the ledger | 404 |
| Ledger slots still with no PDF after this upload | 275 |


## Plan

### 1. Dedup pass (content-level, not filename)
- Hash all 843 uploads (SHA-256) during the store stage.
- For the 46 slots we already hold from RECAP: keep one row per slot. If hashes match, drop the upload and keep the stored copy; if they differ, keep the upload (fuller local copy) and retire the RECAP object.
- Cross-check hashes against all existing Insulin documents to catch a JPML file that duplicates a transferee-docket document; skip any exact-hash repeat.

### 2. Extend the ledger with the 404 unlisted attachments
- Append canonical rows for them to `INSULIN_FULL_DOCKET.csv`, inheriting entry number, filed date, and parent description from the JPML entry they attach to; title comes from the filename; page count / size / hashes computed locally; `public_access_status = LOCALLY_SUPPLIED`.
- This keeps the ledger the single source of truth and lets `verify` reconcile.

### 3. Run the pipeline for the new files
`match → store → write → extract → embed → verify`, scoped to the JPML namespace so the in-flight transferee extraction is untouched (currently 1290/1843, still running — the new work starts after it finishes).

### 4. Missing-file report
The 275 slots that remain PDF-less after your upload:
- **195** are `NO_PUBLIC_PDF_LINK` — mostly text-only minute entries (e.g. `JPML-4 ***TEXT ONLY NOTICE***`) and clerk notations. Nothing exists to fetch; they stay metadata-only records.
- **80** are `PACER_LINK_AVAILABLE` — real PDFs that exist only behind PACER paywall (notices of appearance, corporate disclosures, schedules of actions). I'll export the exact list to `/mnt/documents/insulin-jpml-missing.csv` with entry, attachment, description, and PACER link so you can pull them locally and re-upload in one more batch.

## Technical details
- Slot key: `(entry, attachment)` parsed from filename after stripping the dropzone millisecond prefix; JPML slots are namespaced to `900_000 + entry` by `parse_filename`, already in place.
- Storage keys go to the matters bucket under the matter's document prefix; S3 objects are written only after hash computation, so a hash-duplicate never creates a second object.
- No schema or frontend changes.
