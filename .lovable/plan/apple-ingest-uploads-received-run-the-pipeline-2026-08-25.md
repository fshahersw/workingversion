# Apple ingest — uploads received, run the pipeline

Your upload landed in the corpus bucket: **329 PDFs, 204.6 MB**, all under `apple-smartphone-md-3113/incoming/`. I reconciled them against the full-docket export before running anything:

- **329 of 334 export slots present** — byte sizes match the export exactly on all 329 (zero size mismatches).
- **5 missing files**, all attachments:
  - `0017-005 / 0017-006 / 0017-007` — Exhibits E, F, G (CPM / Nussbaum / KTMC firm resumes)
  - `0020-003` — Appendix (firm resumes)
  - `0100-002` — Exhibit B
- One pipeline fix needed: the dropzone prefixes filenames with a millisecond tag (`1787672725699-0001. …pdf`) for collision safety, and the matcher's filename parser would misread that as the entry number. One-line fix to strip the prefix.

## Work plan

### 1. Fix the filename parser
- `scripts/pipeline/ingest_matter.py`: strip a leading `\d{10,}-` prefix in `parse_filename` before matching. Incoming keys then parse to the correct (entry, attachment) slots.

### 2. You upload the 5 missing attachments (optional but recommended)
- Drop just those 5 files into the same Apple upload dropzone. If you'd rather skip them, the pipeline records them as PACER-linked gaps (they're also in the missing-files CSV) and we proceed with 329.

### 3. Run the pipeline for Apple
```
match (dry-run first, review counts) → match → store → write → extract → verify
```
- **match**: builds the slot plan from the canonical docket export + incoming bucket files; flags any file without a ledger slot.
- **store**: copies each file to the canonical `<slug>/pdf/` key, computing SHA-256 and comparing against the export's expected hash — mismatches are quarantined, not stored.
- **write**: upserts all 391 document rows (292 main + 99 attachments) with hashes, page counts, provenance URLs, and availability status; rolls up entry-level counts.
- **extract**: pulls the text layer per page, writes text objects, builds `doc_chunks` with page spans.
- **verify**: runs the quality gate — every document row has its PDF, hashes verified, page counts complete, text extracted.

### 4. Verification report
- Counts reconciled against the export's own totals (334 files / 6,094 pages / 232.8 MB — adjusted to 329 files if the 5 attachments stay missing), plus a missing/mismatch list if anything fails the gate.

### 5. Embed stage — after verify passes
- Runs only once you provide the **Voyage API key** (secret prompt for `VOYAGE_API_KEY`). voyage-law-2, 1024-dim, fills `doc_chunks.embedding`.

## Technical notes

- No database resets — `docket_entries`, `parties`, and `counsel` stay as-is; `match/store/write/extract` only touch storage and `documents`/`doc_chunks`.
- The store stage is idempotent: already-present canonical files with matching size are reused, so re-runs are cheap.
- The 5 skipped attachments keep their `pacer_url` links and appear in the verification report as known gaps.
