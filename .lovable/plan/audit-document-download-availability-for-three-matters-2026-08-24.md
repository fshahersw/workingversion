# Audit document download availability for three matters

Goal: Clarify what "downloadable" actually means for the three specific matters, and produce a concise audit report showing which documents have real files vs. metadata-only records.

## What we currently have

- The registry stores document **metadata** in `registry.documents` (description, doc UID, SHA-256, byte count, storage path, verification status).
- Two storage backends are referenced:
  1. **Supabase Storage bucket `FORAWS`** — used when `s3_bucket = 'FORAWS'` and `s3_key` is set.
  2. **AWS S3 bucket `kb-staging`** — used for catalog/enrichment documents (the `fromCatalog` overlay) that are not in the registry tables.
- Some rows are marked `sealed`, `unavailable`, or missing `s3_key` entirely — those are metadata-only and not directly downloadable.
- We do **not** yet know, without testing, how many of the stored paths actually resolve to a real object.

## Plan

1. **Identify the three matter IDs** and their document counts.
   - IN RE: INSULIN PRICING LITIGATION (D.N.J. MDL 2:23-md-03080)
   - APPLE INC. SMARTPHONE ANTITRUST LITIGATION (D.N.J. MDL 2:24-md-03113)
   - Master docket 3:16-md-02741, N.D. Cal. (In re Roundup Products Liability Litigation)

2. **Export document metadata for each matter** to `/mnt/documents/three-matters-documents.csv` with columns:
   - `matter_id`, `case_name`, `document_id`, `doc_uid`, `description`, `entry_number`, `docket_entry_id`, `s3_bucket`, `s3_key`, `verification_status`, `byte_count`, `sha256`, `from_catalog`, `storage_type`, `download_url_source`.

3. **Test file reachability** for every document that has a storage path.
   - Supabase Storage paths: generate a signed URL and issue a `HEAD` request.
   - AWS S3 `kb-staging` paths: use the configured S3 connector/gateway to issue a `HEAD` request.
   - Record status: `reachable`, `missing`, `forbidden`, `no_path`, `sealed`.

4. **Produce a summary report** at `/mnt/documents/three-matters-availability-summary.csv` with one row per matter:
   - Total documents, documents with storage path, reachable, metadata-only / no path, sealed / unavailable, missing/forbidden, total bytes reachable.

5. **Show a short explanation in chat** of what the audit found and what the different statuses mean, so the confusion about "all download URLs" is resolved.

## Out of scope

- No app UI changes.
- No backend schema changes.
- No new ingestion or backfill.

## Deliverables

- `/mnt/documents/three-matters-documents.csv`
- `/mnt/documents/three-matters-availability-summary.csv`
- Chat summary of findings.
