# Why the T-Mobile JPML batch is stuck

## What the data shows

Third T-Mobile batch `a9fb63ee-f292-4658-8405-40a673bcbc16`
(`t-mobile-2022-data-breach-md-3073`, 419 docket rows, 466 parties, **315 staged files**):

- `status = queued`, `stage = NULL`, `error = NULL`
- `counts` already contains partial work: `{"stored": 87, "unchanged": 228, "entries": 212, "documents": 419, "failed": 0}`
- `updated_at` froze at 07:32:04 and has not moved across three polls (07:33:04 → 07:33:35)
- No `run_batch.py` process is alive anywhere I can see

JPML coverage today: **145 JPML documents, 91 PDFs stored, only 6 with chunks**.
Main docket is healthy (298 docs / 224 PDFs / 261 chunked). So the JPML PDFs are
physically stored but never got extracted, chunked, or embedded — that work is in the
stalled batch.

## Root cause (confirmed by field values, not inference)

The batch was picked up and got partway through the **store** stage (87 of 315 files
promoted), then the row was flipped back to `status='queued'` with `stage = NULL` and
`error = NULL`, and nothing has touched it since.

That exact field combination cannot come from our code paths:

| Writer | Sets |
| --- | --- |
| `/ingest/batches/:id/commit` | `status='queued'`, `stage='queued'` |
| `run_batch.py release_claim()` | `status='queued'`, `stage='queued'` |
| `run_batch.py requeue_stale()` | `status='queued'`, `stage='queued'`, `error='requeued after stall…'` |
| `run_batch.py` failure path | `status='failed'` + error text |

`stage = NULL` with progress counts present means the reset came from **outside** the
runner — the external pipeline (or a direct DB write) reset the row mid-run, or the
worker process died and something re-queued it without going through `release_claim`.
Either way, the batch is now sitting in the queue with no worker attached: the pool from
the deployment guide is not running on the ETL host, so nothing will ever pick it up.

## Fix, in order

1. **Confirm nothing is mid-flight**, then drain this batch explicitly:
   `python3 scripts/pipeline/run_batch.py --batch a9fb63ee-f292-4658-8405-40a673bcbc16 --worker-id jpml-recover`
   Re-running is safe: store skips already-promoted hashes, extract only touches
   documents without text, embed only touches `embedding IS NULL`.
2. **Verify JPML afterwards**: JPML documents vs PDFs vs chunked should converge
   (expect ~91 chunked JPML docs, not 6), zero unembedded chunks, no duplicate slots.
3. **Delete or ignore the abandoned `open` batch** `38be14e4` (created 07:02, empty
   counts, never committed) so the queue view is clean.
4. **Start the worker pool on the ETL host** using `/mnt/documents/etl-host-deployment.md`
   (`etl-worker@1..3` + `etl-sweeper`). With the pool running, this class of stall
   self-heals in ≤30 minutes via the stale sweeper.

## Guardrails to add (small, app-side)

- **Reject foreign resets**: add a DB check/trigger note in
  `supabase/corpus/ingest-batches.sql` so a batch may only move `running → queued`
  with a non-null `stage`; anything else writes `error` so the Pipeline page can show it.
- **Pipeline page signal**: flag a `queued` batch that already has non-empty progress
  counts as "interrupted mid-run" (amber), distinct from a fresh queued batch — currently
  it looks identical to a normal queue entry.

## Feedback for the external agent

- Never write `corpus.ingest_batches` directly. `commit` is the only allowed transition
  into the queue; the runner owns everything after that.
- Do not re-commit or reset a batch that is `running` — it strands partially promoted
  files and loses the worker's claim.
- Run the pool (`etl-worker@1..3` + `etl-sweeper`) instead of one-shot runs, so a killed
  worker is recovered automatically.

## Notes

- No schema or ingest-contract change is required to recover the batch; steps 1–4 use
  existing, proven paths.
- Step 1 takes a while (315 files, extraction + embedding dominate) and should be run
  in the background with logs, not in a short-lived shell.
