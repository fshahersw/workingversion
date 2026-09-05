# Dedup Apple document holdings (title + file-size match)

## Audit findings (confirmed this turn)

Apple Inc. Smartphone Antitrust Litigation (`447c8a03-…`, 2:24-md-03113):

- 449 documents total; **18 duplicate groups** sharing normalized title + `byte_count`
- **46 rows involved, 28 excess rows** — all from `doc_source = 'catalog'` (the CourtListener/RECAP import)
- Duplicates are RECAP re-download artifacts: same `document_number` + `attachment_number` + `entry_number`, same page count, same date filed; S3 keys differ only by a numeric suffix (`gov.uscourts.njd.550383.2.2.pdf` vs `..._1.pdf` … `..._8.pdf`)
- 17 of 18 groups have differing `sha256` values despite identical size — `byte_count` is the catalog-reported size, so bytes can differ slightly. Canonical pick must prefer hash-verified rows.
- Safety confirmed: `registry.opinions` has 0 links to Apple documents; `meta_repair_staging` has 0 references; no other registry table references `document_id`.
- Every duplicate row is a separate S3 object (46 distinct keys) → storage waste in addition to UI clutter.

## Plan

### 1. Dry-run scan script: `scripts/backfill/dedup_documents.py`
- Groups Apple documents by `(matter_id, lower(trim(description)), byte_count)` where count > 1.
- **Canonical-pick rule per group**: prefer the unsuffixed base S3 key (`...N.M.pdf`), else smallest numeric suffix; break ties by `sha256 IS NOT NULL`, `is_available`, then lowest `document_id`.
- **Safety gates** (skip + report group if any fail):
  - All rows in group share the same `document_number` / `attachment_number` / `entry_number` (proves same docket slot).
  - No row slated for deletion is referenced by `registry.opinions` or `registry.meta_repair_staging` (re-point to canonical if ever found).
- `--apply` flag off by default; dry-run prints the full keep/delete decision table.

### 2. Apply: transactional delete
- Delete the 28 excess rows from `registry.documents` in one transaction.
- Expected result: 449 → **421 documents**, 0 duplicate groups on re-scan.

### 3. S3 cleanup (same run, after DB commit)
- Delete the 28 redundant suffixed objects from the `recap-pdfs/…` prefix using the existing AWS env credentials + `S3_ENDPOINT` (same pattern as `s3.server.ts`).
- Deletion happens only after the DB transaction commits; failures are logged, not fatal.

### 4. Report + verify
- Export the full decision log (group, kept ID/key, deleted IDs/keys, hashes) to `/mnt/documents/apple-dedup-report.csv`.
- Re-run the scan query to confirm 0 duplicate groups; spot-check the Matter detail page filing register renders unchanged (fewer redundant document chips per entry).

## Out of scope (flag for later)
- Insulin Pricing and Roundup almost certainly have the same RECAP re-download artifact pattern; the script takes any `matter_id`, so extending it later is a one-line change.
- 172 Apple documents have no `byte_count` and 222 lack `sha256` — those can't be size-matched today; a hash-backfill pass would enable hash-based dedup later.

## Technical details
- Dedup key: `(matter_id, lower(btrim(description)), byte_count)` — matches the user's "exact same title and file size" criterion, normalized for case/whitespace.
- No schema changes, no frontend changes, no backend/edge-function changes.
- All DB writes go through `psql $CORPUS_DB_URL` (external corpus project), same as prior backfill/promotion scripts.
