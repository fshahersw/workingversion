# First external batch: landed clean, now waiting on a runner

## What the logs show

Your external pipeline's first submission arrived and passed every gate:

- Batch `995baf53-eaf1-4b36-8ad1-60ed2739897e`, matter `t-mobile-2022-data-breach-md-3073`
- Submitted 05:34:41 UTC by `codex-etl-operator`, mode `full`, contract `1.0`
- Validated at 05:34:47 with **0 rejects**
- Counts: 428 docket rows, 466 party rows, 8 staged PDFs (50 pages, 1,171,465 bytes)
- Status: `queued`, stage `queued`, no error
- Two dockets declared: `main` (4:23-md-03073) and `jpml` (MDL No. 3073)

Create → upload → validate → commit all worked against `https://swtesting.dev/api/public/ingest`. Nothing is wrong with the submission.

## Why it is still sitting there

`queued` is the hand-off point. The ingest API stages and validates; the actual work
(promote PDFs to canonical S3 keys, verify hashes, extract text, chunk, embed, write
matter/entries/documents/parties, refresh ordering) is done by
`scripts/pipeline/run_batch.py`, which today is started by hand. No worker is running,
so the batch will stay `queued` indefinitely. The Pipeline page is observe-only by
design, so it reports the state but cannot advance it.

## Proposed next step

1. Run `run_batch.py` against this batch, watching each stage, and report the outcome:
   entries and documents written per docket source, PDFs promoted and hash-verified,
   chunks created and embedded, final batch status.
2. Verify the result in the corpus before calling it done: composite identity uniqueness,
   no synthetic JPML numbers, ordering refreshed, zero unembedded chunks, and the matter
   rendering correctly on its matter page.
3. Report any gaps found (for a 428-slot docket with only 8 PDFs, most rows will be
   `pacer_link` / `text_only` — I will confirm the availability breakdown matches what
   the manifest declared).

## Optional follow-on (say the word and I will fold it in)

An automatic drain so future batches do not need a manual kick: a cron-triggered
`/api/public/ingest/drain` endpoint that claims one queued batch at a time
(`FOR UPDATE SKIP LOCKED`) and runs the same stages, with a Retry control added to the
Pipeline page. This is a bigger change and is not part of step 1 above.

## Technical notes

- No contract or schema changes; the runner logic already exists and was proven on the
  golden bundle round-trip.
- Batch claim is idempotent via `idempotency_key` `etl-2026-08-27-t-mobile-3073-001`;
  re-running is safe.
- Embeddings use Voyage `voyage-law-2` at 1024 dimensions, same as the existing matters.
