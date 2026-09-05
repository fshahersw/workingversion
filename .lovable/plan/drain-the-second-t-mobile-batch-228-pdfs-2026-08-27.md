# Drain the second T-Mobile batch (228 PDFs)

## What the queue shows

- `5577fbf1-6491-4980-b5bd-51a5e1a7aa6f` — `t-mobile-2022-data-breach-md-3073`, mode `full`,
  submitted 06:19 UTC, validated at 06:21 with **0 rejects, 0 warnings**.
  Counts: 419 docket rows, 466 party rows, **228 staged PDFs** (up from 8 in the first run).
  Status: `queued`, stage `queued`, no error.
- Earlier attempt `1b4b929b` failed validation (10 errors) and was correctly re-submitted.
- The first batch `995baf53` completed at 05:42 (8 PDFs).

Nothing is wrong with the submission. It sits at `queued` because the worker
(`scripts/pipeline/run_batch.py`) is started by hand and no worker is attached.
The Pipeline page is observe-only by design.

## Proposed steps

1. Run `run_batch.py --batch 5577fbf1-6491-4980-b5bd-51a5e1a7aa6f` and watch each stage:
   promote + hash-verify the 228 PDFs, extract text, chunk, embed with `voyage-law-2`,
   upsert matter/entries/documents/parties, refresh ordering, complete the batch.
2. Verify afterwards: PDF count and hash matches, extracted/chunked/embedded counts with
   zero unembedded chunks, composite identity uniqueness, no synthetic entry numbers
   surfacing in display order, and the matter page rendering correctly.
3. Report the availability breakdown (free-PDF vs pacer_link vs text_only vs sealed) and
   how it changed versus the 8-PDF first run.

## Optional follow-on

An automatic drain so batches never sit queued: a cron-triggered
`/api/public/ingest/drain` endpoint claiming one queued batch at a time
(`FOR UPDATE SKIP LOCKED`), plus a Retry control on the Pipeline page. Larger change —
say the word and I will fold it in. Otherwise the external host should run
`run_batch.py --poll 30` continuously, or `--once` right after each commit.

## Technical notes

- No contract or schema changes; this is a run of the existing, proven runner.
- Re-running is safe: batch claim is idempotent and document identity is composite.
- 228 PDFs will take noticeably longer than the first run (extraction + embedding dominate).
