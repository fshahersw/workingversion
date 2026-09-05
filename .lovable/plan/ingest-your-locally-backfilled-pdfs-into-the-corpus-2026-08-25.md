# Ingest your locally backfilled PDFs into the corpus

## The gap your files close

Verified in the registry right now:

| Matter | Document rows | Rows with a stored PDF | Missing a PDF |
|---|---|---|---|
| Apple 2:24-md-03113 | 409 | 227 | 182 |
| Insulin 2:23-md-03080 | 1,642 | 1,235 | 407 |
| Roundup 3:16-md-02741 | 31,304 | 31,304 | 0 |

Also missing everywhere: `sha256` is null on all three dockets, and page counts are partial (Apple 275/409). Your local set is the only source for the missing files and the only way to compute real hashes.

## How your filenames map

Your naming is fully parseable:

```text
0133. (11-19-2025) NOTICE of Voluntary Dismissal Without Prejudice by KYLE T. WHITESIDE.pdf
 ^^^^   ^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 entry  date filed  description

0140-003. (11-20-2025) (Exhibit).pdf
 ^^^^ ^^^
 entry attachment 3
```

- `0133` -> `entry_number = 133`, `attachment_number = NULL` (main document)
- `0140-003` -> `entry_number = 140`, `attachment_number = 3`
- The parenthesised date is the filing date, checked against `date_filed` on the docket entry
- The trailing text is a human description, used only where CourtListener gave none

That gives an exact join key against `registry.documents (matter_id, entry_number, attachment_number)` — the same key the CourtListener promotion already used.

## Steps

**1. You stage the folder.** Put each docket's PDFs in one folder per matter and tell me the path (upload to the sandbox or to a temp S3 prefix — whichever is easier for a few hundred files). Nothing is renamed on your side.

**2. Parse and dry-run match.** A script reads every filename, derives entry/attachment/date/description, and reports before touching anything: how many files match an existing document row, how many match a row that currently has no PDF (the win), how many are duplicates of files already stored, and how many match nothing. You approve the numbers before anything is written.

**3. Compute per-file facts.** For each PDF: sha256, byte count, and page count read from the PDF structure. This is what fills the `sha256` column that is currently empty across all three dockets, and gives real page counts.

**4. Upload to S3 under the existing convention.** Files go to the same `kb-staging` bucket and `recap-pdfs/<docket_id>/` prefix the registry already uses, so every existing app link and the document viewer keep working with no code change. Where CourtListener supplied a filename we reuse it; for documents that only exist in your set, the key follows the same `gov.uscourts.<court>.<case>.<entry>.<attachment>.pdf` shape. Existing objects are never overwritten unless the hash differs and yours is the more complete file.

**5. Write metadata back.** One transactional update per matter fills `s3_bucket`, `s3_key`, `sha256`, `byte_count`, `page_count`, and `description` (description only where empty). Documents present in your folder but absent from the registry get inserted with a docket entry link, under a new release id `local-backfill-v1`, matching how `cl-backfill-v1` was recorded. Nothing is deleted or overwritten with worse data.

**6. Verify and report.** Re-run the coverage table above, spot-check a handful of PDFs opening from the app, and write a CSV of every file with its match outcome to `/mnt/documents/local-backfill-report.csv`, including anything unmatched so you can eyeball it.

## Technical notes

- Scripts live under `scripts/backfill/` and run against `CORPUS_DB_URL` and the existing S3 credentials — one-off data operations, not app runtime code.
- Idempotent: re-running re-parses, re-matches on sha256, and skips anything already stored.
- Filename dates are treated as a cross-check, not authority; CourtListener's `date_filed` wins on conflict, and conflicts are listed in the report.
- Descriptions from filenames are recorded with `text_source = 'local-pdf'` so their provenance is distinguishable from `courtlistener`.
- No app or UI changes — the Matters views read these columns already.

## Out of scope

Full text extraction, chunking, and embeddings. The same hashes and page counts make that a clean follow-on pass whenever you want it.
