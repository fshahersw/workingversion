# Fix the queue drain + synthetic entry numbers

Two fixes from the first live external batch, plus the feedback list for your pipeline agent.

## 1. Draining queued batches automatically

The runner (`scripts/pipeline/run_batch.py`) needs `psycopg`, `boto3` and `pypdf` — a real Python host. The app's own backend runs on an edge worker, so it cannot execute the runner itself; an in-app cron endpoint is not possible without rewriting extraction/embedding in TypeScript.

So the drain is owned by whichever machine runs your external pipeline:

- Run the runner in daemon mode next to the pipeline: `python3 scripts/pipeline/run_batch.py --poll 30`. It already claims work with `FOR UPDATE SKIP LOCKED`, so multiple workers are safe.
- Alternatively, have the external agent invoke `--once` right after it commits a batch.

To make a stalled queue visible instead of silent, add to the owner-only Pipeline page:

- A "Queued / running" strip at the top with the count and age of the oldest non-terminal batch.
- An amber warning when a batch has sat in `queued` for more than 15 minutes (no worker attached), and a red one when a `running` batch hasn't updated in 30 minutes (crashed worker).
- Auto-refresh already polls every 10s while anything is non-terminal; the strip reuses that.

## 2. Synthetic entry numbers ("TXT 1…23", "JPML TXT 1")

The T-Mobile batch used invented numbers in the `800000` / `700000` range for unnumbered minute entries. They ingested cleanly, but `sort_seq` was set from the raw number, so the JPML one (`700001`) floats above every real JPML entry.

Two parts:

- **Ordering repair**: extend the display-order refresh so an entry whose number is at or above `100000` is not sorted by that number — it sorts by its filed date, slotted just after the last real entry filed on or before that date (exactly how the `main` TXT entries happen to land today). Then re-run the refresh for the T-Mobile matter so `jpml 700001` sits in date order instead of on top. Its display label stays the human one ("JPML TXT 1"), never the raw 700001.
- **Contract guard**: the validator warns (not rejects) when a manifest/docket declares `entry_number >= 100000`, with a reject-style message naming the row and telling the sender to use the real number plus a text-only label. Warning-level so in-flight batches from your agent still land while it is being corrected.

## Technical notes

- Ordering change lands in `supabase/corpus/refresh-display-order.sql` (the `sort_seq` computation), applied as a migration and then re-run for `t-mobile-2022-data-breach-md-3073` only. No document, chunk or S3 changes; entry numbers themselves are left exactly as submitted.
- Queue strip is presentation-only inside `src/routes/_authenticated/pipeline.tsx` plus a small counter in `src/lib/pipeline.server.ts`; no new endpoints, no change to the ingest contract or the public routes.
- Validation warning goes in the validate route's row checks, alongside the existing reject codes.

## 3. Feedback to hand your pipeline agent

1. **Never invent entry numbers.** Unnumbered minute/text entries keep the real docket number they belong to (or the previous entry's number with a new attachment slot); the fact that there is no document goes in `entry_label` / `availability_status: text_only`, not in the number.
2. **Descriptions matter.** 393 documents came in with the placeholder "CourtListener docket event" as the description. That text is what the research agent retrieves and cites — send the actual docket text, or leave it empty rather than filling it with boilerplate.
3. **Coverage was thin on PDFs**: 8 stored out of 428 documents. If free PDFs exist on CourtListener/RECAP for more of these entries, fetch them before submitting; a `pacer_link` row is invisible to retrieval.
4. **Everything else was clean** — contract version, idempotency key, composite identity, CSV formatting, hashes, page counts and byte counts all validated first try with zero rejects. Keep that shape.
5. **Kick the runner after commit** (or leave a `--poll` daemon up), otherwise a committed batch waits indefinitely.
6. **Use the stable published host** for submissions and keep the one-hour presigned upload window in mind for large PDF sets — re-open the batch rather than reusing expired URLs.
