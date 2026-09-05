# Corpus Quality Scan (starting with Apple MDL)

You're right — Apple is not missing the docket so much as missing *labels*. A scan of `2:24-md-03113` right now shows:

| Field | Status |
|---|---|
| Document rows | 409 (288 docket entries, highest entry no. 292) |
| Stored PDFs | 227 of 409 |
| Blank document description | 23 |
| Blank docket-entry description | 22 |
| Missing `doc_category` | 409 (100%) |
| Missing `entry_date_filed` | 409 (100%) |
| Missing `sha256` | 409 (100%) |
| Missing `page_count` | 134 |
| Missing `byte_count` | 132 |
| Missing `attachment_number` | 317 |

So the real gap is metadata hygiene, not file coverage. The parent entry text already contains what most attachments need — e.g. entry 17's text lists `# 1 Exhibit A Hagens Berman Firm Resume ... # 17 Text of Proposed Order`, while its 19 child documents carry generic or empty descriptions.

## What to build

**1. A reusable corpus health scan (SQL + script)**
A `registry.v_document_health` view plus `scripts/audit/corpus_scan.py` that, for any matter or the whole corpus, reports per-matter:
- coverage: entries, documents, documents with PDF, entry-number gaps vs. max entry
- completeness: null/blank rate per field (description, category, date, attachment number, page count, byte count, sha256, pacer id, download url)
- quality flags: description that is a generic stub ("Letter", "Order", empty), attachment rows whose description equals the parent's, duplicate `doc_uid`/`s3_key`, documents orphaned from a docket entry, sha/byte mismatch against the S3 object
- an overall 0-100 health score per matter and a ranked "worst offenders" list

Output: a summary table in the terminal, a CSV to `/mnt/documents/corpus-health-<date>.csv`, and a row-level defect list so fixes can be targeted.

**2. A repair pass driven by the scan (dry-run first)**
- Derive `attachment_number` and per-attachment description by parsing the `(Attachments: # 1 ... , # 2 ...)` block in the parent entry text.
- Backfill `entry_date_filed` from the linked docket entry's `date_filed`.
- Classify `doc_category` from the description (motion, brief, order, exhibit, declaration, transcript, notice, letter, other).
- Backfill `sha256`, `byte_count`, and `page_count` by reading each stored S3 object.
- Leave anything ambiguous untouched and list it for CourtListener/local-PDF backfill instead.

Every write goes through a staging table + promote SQL, same pattern as the existing CourtListener and local-PDF backfills, so it's idempotent and re-runnable.

**3. Run order**
Scan Apple → review the defect report with you → run repair in dry-run → promote → re-scan to confirm the score moves. Then repeat the same scan across Insulin, Roundup, and the rest of the registry.

## Technical notes
- New: `supabase/corpus/document-health.sql` (view), `scripts/audit/corpus_scan.py`, `scripts/backfill/repair_metadata.py`, `supabase/corpus/metadata-repair-promote.sql`.
- Uses `CORPUS_DB_URL` for DB and the existing S3 credentials for object checks; no app/runtime code changes.
- Read-only until you approve the repair step.
