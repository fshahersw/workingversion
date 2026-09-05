# Registry corpus: deep analysis + next steps

I queried the live registry (24 tables) directly. Below is what's actually in it, what's broken, and what I'd build next.

## What the corpus actually contains

| Layer | Rows | Notes |
|---|---|---|
| matters | 73 | 57 `target_matter`, 16 `support_master` (MDL masters) |
| docket_entries | 24,598 | **only on the 16 masters** |
| documents | 13,971 | **only on the 16 masters**; 3.9 GB, all in bucket `FORAWS`, all `verified` |
| parties | 325 | **only on the 57 member matters**; 323 of 325 are typed `Plaintiff` |
| counsel_appearances | 489 | only on the 57 member matters (130 attorneys, 10 firms) |
| judicial_assignments / judges | 68 / 25 | broad coverage |
| outcomes | 25 | FJC disposition rows, `raw_codes` mostly empty strings, no amounts |
| matter_relationships | 53 | all `member_of_mdl` |
| opinions / citations | 0 / 0 | **no case law in the corpus at all** |
| provenance / records / source_records | 72,541 / 169,444 / 35,588 | full lineage layer, unused by the app |
| review_records | 21,454 | **all open**, all `document_verification` |
| courts | 13 | |

## The five real problems

1. **The data is split down the middle.** Masters have all the filings but zero parties/counsel. Member matters have parties/counsel but zero filings. So every matter page is half-empty no matter which one you open — this is a corpus gap, not a UI bug.
2. **Master dockets are truncated.** Every large master stops at 1,200–2,000 entries (Xarelto 1,967, AFFF 1,997, Cook 1,988). Real MDL masters run 10k–30k entries. The ingest is capping.
3. **`entry_number` is text.** Max value by sort is the string `"999"`, so chronological/numeric ordering is wrong everywhere. There is also **no date column** — 93% of entries only carry `(Entered: MM/DD/YYYY)` inside the description string.
4. **The verification story contradicts itself.** All 13,971 documents say `verified`, yet 21,454 open review records say otherwise: 19,407 `missing_receipt_path`, 2,028 `transfer_size_mismatch`, 17 `transfer_sha1_mismatch`. Nothing in the app surfaces this.
5. **No document text.** No OCR/extracted-text/embedding table exists. Documents are S3 blobs with a short PACER label (`"Motion to Amend/Correct"`). Semantic search, chronologies, and citation-grounded answers over filings are impossible until text is extracted.

## Proposed next steps

### A. Registry-side fixes (SQL + ingest, highest value)
- `docket_entries.entry_number_int` generated column + `entered_at date` parsed from the description tail, with indexes. Fixes ordering, date filters, and timelines in one shot.
- Lift the per-docket ingest cap and re-pull the 16 masters; backfill parties/counsel for masters and docket entries for member matters.
- Reconcile `verification_status` against `review_records` so "verified" means verified.
- `registry.matter_stats` + `docket_entry_document_counts` (already written in `supabase/corpus/registry-scale.sql`, not yet applied) to turn the count columns back on.

### B. Document text layer (unlocks everything AI)
Background job: pull each `FORAWS` object, extract text (native PDF text first, OCR fallback), store `document_text` (page-level) + `document_chunks` with embeddings. Then: semantic search over filings, pinpoint page cites, chronologies, deposition prep.

### C. App-side work that pays off before A/B land
- **Corpus Health page** — coverage matrix (which matters have entries/docs/parties/counsel), the 21k open review queue with reason breakdown, release/load-run status, GB in S3. Makes the gaps visible instead of surprising.
- **Honest matter pages** — master pages link to their 53 member cases for parties/counsel; member pages link up to the master's docket. Explicit "not in this release" states, never blank tabs.
- **Cross-matter filing search** — one search across all 24,598 entries with type/court/matter facets, since the per-matter view is where the data actually is.

## Technical notes

- Registry access is server-side only via PostgREST + `CORPUS_SERVICE_KEY` (`src/lib/corpus.server.ts`), schema `registry`; that stays.
- Section A is SQL I hand you for the registry project (like `supabase/corpus/registry-scale.sql`) — I can't run migrations there.
- Section B needs a worker outside this app (the Worker runtime can't OCR 3.9 GB); this app would only read the resulting tables.

## What I need from you

Which do you want first: the **Corpus Health + honest matter pages** app work (I can do it now), or the **registry SQL pack** (entry_number_int, entered_at, stats views) for you to run before the 2,500 matters land?
