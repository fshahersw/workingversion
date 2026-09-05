# ETL worker pool — automatic, parallel queue drain

`commit` on the ingest API only marks a batch `queued`. Workers do the real work.
Run a small pool on the ETL host and you never hand-run anything again.

## What makes N workers safe

| Risk | Guard |
| --- | --- |
| Two workers take the same batch | `claim()` uses `UPDATE ... FOR UPDATE SKIP LOCKED` |
| Two batches write the same matter at once | session advisory lock `hashtext('ingest:<slug>')`; loser releases its claim back to `queued` |
| Worker dies mid-run, batch stuck `running` | 60s heartbeat on `updated_at` + `--requeue-stale` sweeper requeues after 30 min |
| Shared Voyage rate limit | exponential backoff with jitter (6 attempts, capped at 120s) in `embed_with_backoff` |
| Re-running a batch | every stage is idempotent (composite identity, hash checks, `embedding IS NULL` only) |

Different matters run fully in parallel. Two batches for the *same* matter serialize —
that is deliberate, not a bottleneck to remove.

## Install (systemd, ETL host)

```bash
sudo mkdir -p /var/log/swtesting /etc/swtesting
# env file must export: CORPUS_DB_URL, VOYAGE_API_KEY,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_ENDPOINT
sudo install -m 600 etl.env /etc/swtesting/etl.env

sudo cp scripts/pipeline/etl-worker@.service /etc/systemd/system/
sudo cp scripts/pipeline/etl-sweeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now etl-worker@1 etl-worker@2 etl-worker@3
sudo systemctl enable --now etl-sweeper
```

Pool size 3 is the default recommendation. Raise it only if Voyage 429 retries stay rare
in the logs.

```bash
journalctl -u 'etl-worker@*' -f          # or tail /var/log/swtesting/etl-worker-*.log
systemctl restart etl-worker@2
```

## Without systemd (containers, tmux, quick test)

```bash
for i in 1 2 3; do
  python3 scripts/pipeline/run_batch.py --poll 20 --worker-id "w$i" &
done
python3 scripts/pipeline/run_batch.py --poll 60 --requeue-stale --worker-id sweeper &
```

## Manual modes (still available)

```bash
python3 scripts/pipeline/run_batch.py --once            # drain one batch, exit
python3 scripts/pipeline/run_batch.py --batch <uuid>    # a specific batch
python3 scripts/pipeline/run_batch.py --requeue-stale --once   # recover, then drain one
```

## Observability

The owner-only `/pipeline` page shows queued/running counts, per-batch stage, the
`worker_id` that claimed each batch, and elapsed time. Amber after 15 minutes queued,
red after 30 minutes of a running batch with no progress — if you see red and the pool
is up, check the worker logs for a crash loop.

Worst-case pickup latency is the poll interval (~20s); there is no push/kick by design.

---

## Scratch pool (Docling ingestion for the ephemeral workspace)

A second, independent pool drains `scratch.jobs` — one job per 50-page span of an
uploaded document. It never touches the permanent corpus and never writes to S3.

Two queues, sized separately:

| Queue | Docling mode | Throughput | Where |
| --- | --- | --- | --- |
| `text` | layout only, OCR off | ~20 pp/s/proc | CPU host is fine |
| `ocr`  | layout + OCR | ~2.5 pp/s/proc | pin to the GPU host |

A span goes to `ocr` only when at least one of its pages has no text layer, so a
mostly born-digital load barely touches the expensive queue. Sizing for the
50k-page / 10-minute target: 8 `text` workers and 8 `ocr` workers.

```bash
pip install docling pypdfium2 psycopg2-binary requests

# CPU host
for i in 1 2 3 4 5 6 7 8; do
  python3 scripts/pipeline/scratch_worker.py --queue text --poll 5 --worker-id t$i &
done

# GPU host
export DOCLING_DEVICE=cuda
for i in 1 2 3 4 5 6 7 8; do
  python3 scripts/pipeline/scratch_worker.py --queue ocr --poll 5 --worker-id o$i &
done
```

Under systemd: `systemctl enable --now scratch-worker@text-1 … scratch-worker@ocr-8`
(the part of the instance name before the dash selects the queue).

Env: `CORPUS_DB_URL`, `VOYAGE_API_KEY` (embeddings batch 128 texts/request — this
is what keeps a 50k-page load in minutes), optional `DOCLING_DEVICE`, and
`SECOND_OPINION=1` plus `AWS_BEARER_TOKEN_BEDROCK` to re-read low-confidence
pages with the Bedrock VL model.

Retention is enforced in the database, not by the workers: raw PDF bytes are
nulled the moment a document's spans finish (6h hard ceiling) and whole sessions
are deleted after a rolling 3 days. `scratch.sweep()` runs every 15 minutes via
pg_cron and also requeues spans whose worker died.
