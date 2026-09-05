# Auto-updating matters: webhook-driven docket sync

## Short answer to "do we ping every 5 minutes?"

No. Polling every docket every 5 minutes is the wrong shape here: it burns API quota, adds minutes of lag anyway, and gets rate-limited as the corpus grows. Both providers you have push to us instead:

- **CourtListener** supports *docket alerts* that fire a **webhook POST** to a URL we own the moment a new entry lands in RECAP. No polling.
- **DocketBird** supports a **webhook** that delivers new filings (including the PDF) to our endpoint in real time, plus a REST API for on-demand fetches.

So: providers push, we ingest. A slow safety-net sweep (hourly, not 5-minute) catches anything a webhook dropped.

## How the pieces fit

```text
CourtListener docket alert ─┐
                            ├─> /api/public/webhooks/*  ->  corpus.docket_events (raw, deduped)
DocketBird webhook ─────────┘                                        |
                                                                     v
                                              refresh worker: build ETL v1 batch
                                              (manifest + docket.csv + PDFs)
                                                                     |
                    POST /ingest/batches -> validate -> commit  ->  status='queued'
                                                                     |
                                          existing etl-worker pool (run_batch.py)
                                          store -> write -> extract -> embed -> finalize
                                                                     |
                                                     Matter page shows the new entry
```

Nothing about the existing ingest contract, composite identity, or worker pool changes. The docket feed simply becomes another producer of batches, which is exactly what the current architecture was built for.

## What gets built

**1. Watch registry (`corpus.docket_watches`)**
One row per tracked docket: matter, court id, docket number, docket source, CourtListener docket id + alert id, DocketBird docket id, last event time, last sync time, status, consecutive failure count. Every matter in the corpus that has a resolvable court + docket number gets a watch (your choice: all matters).

**2. Subscription manager**
A script/owner-triggered job that, for each matter without a live watch:
- resolves the CourtListener docket (court + docket number lookup),
- creates a docket alert pointed at our webhook,
- registers/records the DocketBird docket id,
- writes the watch row and reports matters it could not resolve (bad court code, state court, no PACER presence) so you can fix them by hand.

Re-runnable and idempotent; never creates duplicate alerts.

**3. Webhook receivers (public routes)**
- `src/routes/api/public/webhooks/courtlistener.ts`
- `src/routes/api/public/webhooks/docketbird.ts`

Each verifies a shared secret before touching data, stores the raw payload in `corpus.docket_events` with a unique key on (provider, provider event id) so replays are harmless, and returns 200 immediately. No parsing or ingestion happens inside the request — providers retry on slow responses.

**4. Refresh worker (`scripts/pipeline/refresh_dockets.py`)**
Claims unprocessed events in bounded batches with `FOR UPDATE SKIP LOCKED`, groups them per matter, and for each new entry:
- normalizes to the docket CSV contract (entry number, attachment number, filed date, description, docket source) — never inventing numbers,
- **PDF: DocketBird first**, CourtListener/RECAP free copy as fallback; if neither has it, the entry is ingested as metadata-only and flagged `pdf_pending` for a later retry pass so the docket is never blocked on a document,
- assembles a manifest + docket.csv + files and drives the existing `batches -> validate -> commit` endpoints with `X-Ingest-Key`.

Then the existing worker pool does store/extract/embed as it does today. Because identity is `(matter, docket_source, entry_number, attachment_number)`, a duplicate webhook produces an upsert, not a duplicate row.

**5. Hourly reconcile sweep**
For every watch, ask CourtListener for entries modified since `last_sync` and enqueue anything we are missing. This is the safety net for dropped webhooks and for matters where the alert failed to register. Bounded per run, single-flight locked, resumable.

**6. Owner-only observability**
Extend the existing `/pipeline` page: watch count and health, last event received per provider, events pending, matters with no watch, `pdf_pending` backlog, and recent failures. Read-only.

## Costs and limits worth knowing

- CourtListener docket alerts and webhooks are free to receive; docket-alert counts are capped per account tier, so tracking every matter may need an account bump — the subscription manager reports when it hits a cap instead of failing silently.
- DocketBird fetching a document that is not already cached can incur PACER fees. That is why the fallback order is DocketBird -> RECAP free copy -> defer, and why PDF fetching is bounded per run.
- Webhook endpoints live under `/api/public/*` (the only prefix external callers can reach) and are secured by a shared secret plus provider signature where available.

## Technical notes

- New secret required: `DOCKETBIRD_API_KEY` (and a generated `DOCKET_WEBHOOK_SECRET`). `COURTLISTENER_API_TOKEN` and `INGEST_API_KEY` already exist.
- Webhook URLs use the stable project URL so they survive renames.
- All new tables are service-role only with bridge views, matching the existing corpus pattern.
- Every background job gets a bounded batch size, a single-flight lease, idempotent progress marking, and a circuit breaker that pauses on repeated provider 4xx/429 and surfaces it on `/pipeline`.

## Rollout

1. Schema + webhook endpoints + secrets.
2. Subscribe a pilot set (3-5 matters) and confirm live entries land end to end.
3. Backfill watches for all matters, review the unresolved list.
4. Enable the hourly reconcile sweep and the `pdf_pending` retry pass.
