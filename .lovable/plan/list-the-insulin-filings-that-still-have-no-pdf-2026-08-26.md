# List the Insulin filings that still have no PDF

## What the corpus actually shows

Confirmed by querying the corpus right now for matter `insulin-pricing-md-3080`:

| Docket | Document rows | Stored PDF | No PDF |
| --- | --- | --- | --- |
| Main (D.N.J. 2:23-md-03080) | 1,894 | 1,187 | 707 |
| JPML (MDL 3080) | 1,125 | 850 | 275 |
| **Total** | **3,019** | **2,037** | **982** |

Why the 982 have no file:

| Docket | Reason | Count | Has a PACER link |
| --- | --- | --- | --- |
| Main | `text_only` (minute/clerk entries, nothing to fetch) | 408 | 35 |
| Main | `pacer_link` (real PDF, paywalled) | 299 | 299 |
| JPML | `text_only` | 195 | 0 |
| JPML | `pacer_link` | 80 | 80 |

None are sealed. So ~603 are text-only records with no document to retrieve, and **414 are real PDFs obtainable only from PACER** — those are the ones worth pulling locally and re-uploading.

## Plan

1. Export one CSV per docket to `/mnt/documents/`:
   - `insulin-missing-main.csv` (707 rows)
   - `insulin-missing-jpml.csv` (275 rows)

   Columns: `display_label` (e.g. `1046`, `JPML 472-2`), `entry_number`, `attachment_number`, `date_filed`, `title`, `availability_status`, `pacer_url`, `courtlistener_url`, `record_id`.

2. Also export `insulin-missing-fetchable.csv` — only the 414 `pacer_link` rows, sorted by entry, as the actionable pull list.

3. Show in chat the first ~20 fetchable entries per docket plus the totals above, so you can eyeball what's needed before pulling from PACER.

## Notes

- Read-only export; nothing in the corpus, S3, or embeddings changes.
- The text-only rows stay as metadata records — that is correct, no PDF exists for them.
- Once you re-upload the PACER pulls, the existing dropzone + `match → store → write → extract → embed → verify` pipeline (with the JPML namespace) absorbs them without schema changes.
