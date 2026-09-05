# Ingest the newly uploaded Insulin docket + JPML PDFs

You uploaded a large batch of PDFs into the Insulin matter. They currently sit in the
staging area only — the app still shows the old coverage numbers, because uploaded files
are not part of the searchable corpus until they are matched to docket slots, moved to
canonical storage, and indexed.

## What's actually there right now

- Matter: `insulin-pricing-md-3080`
- 1,294 uploaded PDFs waiting in staging (`.../incoming/` for main docket, `.../incoming/jpml/` for JPML)
- Existing corpus: 3,019 documents — main docket 1,894 (1,187 with a stored PDF), JPML 1,125 (850 with a stored PDF)
- 379 documents are still marked "no PDF"; 772 still point at a paid PACER link
- Text/RAG index: 2,640 documents extracted, ~27k chunks

So the upload should close most of the ~800 missing-PDF gaps and add slots the court export never listed (attachments in particular).

## Plan

1. **Inventory and dry run.** Parse every staged filename into entry number, attachment
   number, filed date and title (the uploader prefixes an upload timestamp, which gets
   stripped). Report: how many map to an existing docket slot, how many are brand-new
   slots, how many are unparseable, and any duplicates. Nothing is written yet — you see
   the numbers first.
2. **Extend the ledger.** For files whose (entry, attachment) slot doesn't exist yet,
   append canonical ledger rows using the existing `extend_ledger_from_uploads.py` path,
   inheriting the parent entry's label, filed date and docket description.
3. **Promote into canonical storage.** Copy each staged file to its canonical key
   (`<slug>/pdf/0703-000.pdf`, `<slug>/pdf/JPML-472-002.pdf`), computing sha256, byte
   count and page count. Existing canonical files are never overwritten with a different
   hash — conflicts are reported, not silently replaced.
4. **Update the corpus records.** Fill `s3_key`, hashes, sizes, page counts; flip
   `availability_status` to `local_supplied` and `text_status` off `no_pdf` for newly
   backed documents; refresh `display_number` / `display_label_pretty` / `sort_seq` so
   ordering stays correct for both the main and JPML dockets. Recorded as an
   `ingest_runs` row for provenance.
5. **Extract text and index for RAG.** Run text extraction and chunking for the newly
   backed documents only, so the research agent can cite them.
6. **Verify.** Re-run coverage counts (documents with PDFs, remaining no_pdf/pacer_link),
   spot-check a handful of new entries in the Matters UI, and confirm the docket ordering
   and newest 2026 entries render correctly.

## Defaults I'll use unless you say otherwise

- Staged files in `incoming/` are **kept** after promotion (copy, not move), so nothing is
  lost if a mapping needs redoing. Cleanup can be a separate pass once you're happy.
- Duplicate content (same sha256 already stored under the same slot) is skipped, not
  re-added.
- Only `insulin-pricing-md-3080` is touched; the Apple matter's staged files are left alone.

## Technical notes

- Parser: `^(\d{1,5})(?:-(\d{1,3}))?\.\s*(?:\((\d{2})-(\d{2})-(\d{4})\))?\s*(.*)\.pdf$`
  applied after stripping the `<epoch-ms>-` upload prefix; JPML files are those under the
  `incoming/jpml/` prefix and take the `JPML-` entry label.
- Scripts reused: `scripts/pipeline/extend_ledger_from_uploads.py`,
  `scripts/backfill/ingest_local_pdfs.py`, `scripts/pipeline/ingest_matter.py`, plus the
  `supabase/corpus/refresh-display-order.sql` ordering refresh.
- Writes go to `corpus.docket_entries`, `corpus.documents`, `corpus.doc_chunks`,
  `corpus.ingest_runs` on the external corpus database. No app/frontend code changes are
  expected; if coverage badges need new states, that's a small follow-up.

Note: the unrelated `kb-staging` legacy bucket deletion is still running in the background
(~205k of 686k objects left) and doesn't affect this work.
