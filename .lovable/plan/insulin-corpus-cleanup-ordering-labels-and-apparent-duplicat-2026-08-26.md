# Insulin corpus cleanup — ordering, labels, and apparent duplicates

## What I found (verified against the live corpus)

The Insulin matter (`insulin-pricing-md-3080`) holds 3,019 documents across 1,949 docket entries, combining two dockets:

- D.N.J. transferee docket 67665081 — 1,894 documents, 1,342 entries
- JPML docket 67376316 — 1,125 documents, 607 entries

**There are no true duplicates.** Checks came back clean: 0 duplicate SHA-256 groups, 2,037 unique S3 keys for 2,037 stored PDFs, 0 duplicate `(entry_label, attachment_number)` pairs, 0 duplicate chunks, 0 orphaned documents or entries.

The real problems are ordering and labeling:

1. **Synthetic entry numbers break docket order.** Rows that had no real docket number were parked in numeric ranges that sort *above* the real docket:
   - 1,596 rows — real D.N.J. entries 1–1046 (correct)
   - 298 rows — D.N.J. rows with blank entry numbers, forced into 800001–800298
   - 994 rows — JPML numbered pleadings, offset into 900001+
   - 131 rows — JPML rows with blank numbers, offset into 1600001–1600131

   Every list in the app sorts by `entry_number` descending, so the JPML 1.6M/900k block sits on top and the actual D.N.J. docket is buried below it.

2. **Meaningless labels are shown to users.** Labels like `800001` and `JPML-700131` are internal collision-avoidance artifacts, not real docket citations.

3. **Rows look duplicated because attachments inherit the parent title.** 440 titles repeat across 1,294 extra rows — e.g. JPML pleading 1 has ten attachments, all displaying the identical parent entry description. Distinct files, identical row text.

4. **No explicit docket-source column.** JPML vs D.N.J. is currently inferable only from `record_id` prefixes and numeric ranges, which is why the two dockets interleave badly.

5. **Embeddings are still running:** 11,712 of 22,559 chunks embedded, 10,847 pending. Cleanup will not disturb them (no re-chunking).

## The cleanup

**Data layer (corpus database, additive — no deletes, no re-ingest)**

- Add `docket_source` (`njd` | `jpml`) and `display_label` to `corpus.documents` and `corpus.docket_entries`; backfill from `record_id` and the numeric ranges above.
- Add a stable `sort_seq` used for display ordering: real entry number where one exists; for blank-number rows, position them at their filed date within their own docket rather than at the top.
- Set `display_label` to the real citation form: `12`, `12-3`, `JPML 1`, `JPML 1-3`, and `— (2025-10-14)` for blank-number rows — never `800001` or `JPML-700131`.
- Give attachments distinct titles: `Attachment N to <label> — <trimmed parent description>` so a ten-attachment entry no longer renders ten identical lines.
- Expose the new columns through the `public.corpus_documents` / `corpus_docket_entries` views.

**App layer**

- Matter detail: order by `docket_source`, then `sort_seq`, then attachment number; keep the existing main/JPML panel selector as the source filter so the two dockets never interleave.
- Render `display_label` everywhere a label appears (tables, source cards, citations), and nest attachments visually under their parent entry.
- Sort options (`entry-desc` / `entry-asc` / date) map to `sort_seq`, so "highest entry first" means docket entry 1046, not synthetic 1600131.

**Pipeline**

- Update `scripts/pipeline/ingest_matter.py`, `convert_cl_export.py`, and `extend_ledger_from_uploads.py` to write `docket_source`, `display_label`, and `sort_seq` at ingest time, so Roundup and future matters never inherit the synthetic-number problem.

**Verification**

- Re-run the ordering, duplicate-hash, label-null, and orphan checks; confirm chunk and embedding counts are unchanged; browser check of the Insulin matter page for both docket panels.

## Notes

Embedding continues in the background throughout; nothing in this pass touches `doc_chunks` rows or the PDFs in S3.
