# Instructions for your agent: ETL worker pool automation

## Current state

The parallel worker-pool automation is already implemented in this repo. Your agent does **not** need to re-implement the core logic. It only needs to verify the files are present, run syntax/tests, and produce the deployment/operations instructions for the ETL host.

## Files already in place

| File | What it does |
| --- | --- |
| `scripts/pipeline/run_batch.py` | Claims batches with `FOR UPDATE SKIP LOCKED`, locks each matter via session advisory lock, runs heartbeat while processing, requeues stale runs, retries Voyage with backoff |
| `scripts/pipeline/WORKERS.md` | Human ops guide: risks, install, manual modes, observability |
| `scripts/pipeline/etl-worker@.service` | systemd template for pool workers `etl-worker@1`, `@2`, `@3` |
| `scripts/pipeline/etl-sweeper.service` | systemd unit that runs `--poll 60 --requeue-stale` |
| `src/lib/pipeline.server.ts` | Owner-only server helpers; `summarize()` already computes queue health and stale-running warnings |
| `src/routes/_authenticated/pipeline.tsx` | UI already renders `worker_id`, elapsed time, queue health strip, stale warnings |

## What your agent should do

1. **Verify the Python runner is syntactically valid**
   - `python3 -m py_compile scripts/pipeline/run_batch.py`
   - If it fails, fix the syntax error. Do not change semantics.

2. **Run the ETL self-test once** to confirm the pipeline still works end-to-end
   - Log in to the preview as `fshaher@seegerweiss.com`
   - Open `/pipeline`
   - Click **Run ETL self-test**
   - Confirm all steps pass and the report downloads
   - This validates the runner, extraction, chunking, Voyage embedding, and cleanup

3. **Produce a deployment README for the ETL host**
   - Create `/mnt/documents/etl-host-deployment.md` (or the user's preferred path)
   - Include the exact environment variables required:
     - `CORPUS_DB_URL`
     - `VOYAGE_API_KEY`
     - `AWS_ACCESS_KEY_ID`
     - `AWS_SECRET_ACCESS_KEY`
     - `AWS_REGION`
     - `S3_ENDPOINT`
   - Include how to create `/etc/swtesting/etl.env` with mode `600`
   - Include the systemd install commands from `scripts/pipeline/WORKERS.md`
   - Include how to scale pool size and how to read logs
   - Include a one-line status check: `systemctl status 'etl-worker@*' etl-sweeper`

4. **Do not do these things**
   - Do not change the ingest HTTP contract (`/api/public/ingest/*`)
   - Do not change the database schema
   - Do not add Supabase Edge Functions for queue draining
   - Do not add intra-batch parallel fan-out (not in scope)
   - Do not remove the owner-only allowlist on `/pipeline`

## How the automation works (for reference)

- `commit` on the ingest API marks a batch `queued`
- Each worker polls the corpus DB every 20s, claims the oldest queued batch with `FOR UPDATE SKIP LOCKED`
- Before running, the worker acquires a Postgres session advisory lock keyed by `ingest:<matter_slug>`
- If another worker already holds that lock, the claim is released back to `queued` so a different batch can run
- A background heartbeat touches `updated_at` every 60s so long embed/extract stages do not look dead
- The sweeper unit (60s poll, `--requeue-stale`) resets any batch stuck `running` for more than 30 minutes
- Voyage embedding uses bounded exponential backoff with jitter on rate limits / 5xx
- Every stage is idempotent, so re-running a batch is safe

## Operational commands to include in the README

```bash
# One-time install on the ETL host
sudo mkdir -p /var/log/swtesting /etc/swtesting
sudo install -m 600 etl.env /etc/swtesting/etl.env
sudo cp scripts/pipeline/etl-worker@.service /etc/systemd/system/
sudo cp scripts/pipeline/etl-sweeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now etl-worker@1 etl-worker@2 etl-worker@3
sudo systemctl enable --now etl-sweeper

# Monitor
journalctl -u 'etl-worker@*' -f
journalctl -u etl-sweeper -f

# Manual recovery / single batch
python3 scripts/pipeline/run_batch.py --once
python3 scripts/pipeline/run_batch.py --batch <batch-uuid>
```

## Done criteria

- [ ] `python3 -m py_compile scripts/pipeline/run_batch.py` passes
- [ ] The UI self-test passes end-to-end
- [ ] `/mnt/documents/etl-host-deployment.md` exists and is accurate
- [ ] No source files were modified except to fix a real compile/runtime bug
