# Automate the queue: a parallel worker pool on the ETL host

Goal: never hand-run `run_batch.py` again. Batches drain automatically, several at a
time, without two workers ever colliding on the same matter.

## What already works

`run_batch.py`'s `claim()` takes one queued batch with `FOR UPDATE SKIP LOCKED`, so N
workers already never grab the same batch. `--poll 30` already loops. The missing pieces
are safety rails around running many copies at once, and something that keeps them alive.

## Gaps to close before running N workers

1. **Same-matter collision.** Two batches for the same `matter_slug` running at once would
   both upsert matter/entries/documents and both refresh ordering — last writer wins, and
   ordering can be computed mid-write. Fix: take a Postgres advisory lock keyed on the
   matter slug (`pg_try_advisory_lock(hashtext(slug))`) right after claiming. If the lock
   is held, release the claim (put the batch back to `queued`) and pick the next one.
   Different matters proceed fully in parallel; same-matter batches serialize by design.
2. **No lease / crash recovery.** A worker killed mid-run leaves the batch `running`
   forever. Fix: heartbeat `updated_at` at every stage (already partly there) plus a
   requeue sweep — any `running` batch untouched for 30 minutes goes back to `queued` with
   an `error` note, so another worker retries it. Re-running is already idempotent.
3. **Voyage rate limits are shared.** N workers embedding at once will hit 429s. Fix:
   bounded retry with backoff on 429/5xx in the embed step, and a per-worker concurrency
   cap so the pool's total request rate stays under the account limit. Default pool size 3.
4. **No worker supervision.** Fix: a systemd unit (templated `etl-worker@.service`,
   started as `@1 @2 @3`) with `Restart=always` on the ETL host, each running
   `run_batch.py --poll 20`. A `--worker-id` flag just tags log lines.

## Deliverables

- `scripts/pipeline/run_batch.py`: advisory matter lock + claim release, stage heartbeats,
  embed backoff, `--worker-id`, `--requeue-stale` sweep mode.
- `scripts/pipeline/etl-worker@.service` + a short `scripts/pipeline/WORKERS.md` with the
  install commands (`systemctl enable --now etl-worker@{1,2,3}`) and log locations.
- A stale-batch sweeper: simplest is one extra worker process started with
  `--poll 60 --requeue-stale`, so no new infrastructure is needed.
- Pipeline page (owner-only): show per-batch `worker_id` and elapsed time next to the
  existing queue strip, so the pool is observable. Read-only, no controls.

## What stays sequential (on purpose)

Work *inside* one batch (PDF promotion, extraction, chunking, embedding) still runs in
order on one worker. That is the phase-2 change (a work-items table with per-item claims)
and is not part of this plan — with several matters queued, per-batch parallelism already
keeps the pool busy.

## Technical notes

- No contract or endpoint changes; `commit` still just marks the batch `queued`.
- No schema change strictly required; `worker_id` is written into the existing `counts`
  JSON to avoid a migration.
- Advisory locks are session-scoped and released automatically if the worker dies, so a
  crash can never wedge a matter permanently.
- Polling only, per your choice: worst-case pickup latency is the poll interval (20s).
