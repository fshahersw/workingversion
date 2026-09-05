# Docling ingestion: 50,000 pages to searchable markdown in ~10 minutes

You're right that this should be minutes, not hours — but only if every stage is
sized for the target instead of inherited from the current per-page browser
loop. Below is the throughput budget first, then the design that hits it.

## The 10-minute budget

50,000 pages in 600 seconds is **~83 pages/second sustained**. Each stage gets a
slice, and each slice sets its own parallelism:

| Stage | Volume | Rate per worker | Workers | Wall time |
| --- | --- | --- | --- | --- |
| Docling, born-digital (no OCR) | ~40,000 pp | ~20 pp/s | 8 procs | ~4.2 min |
| Docling + OCR, scanned pages | ~10,000 pp | ~2.5 pp/s (GPU) | 8 procs | ~8.3 min |
| Chunk markdown | ~150k chunks | trivial | inline | — |
| Embed (Voyage, 128 texts/request) | ~150k chunks | ~1.2s/batch | 16 conc. | ~1.5 min |
| `COPY` into Postgres + build HNSW | ~150k rows | — | 1 | ~2 min |

The two Docling stages run concurrently on separate queues, so wall time is
`max(4.2, 8.3) + 1.5 + 2 ≈ 12 min` on the first run and well under 10 once the
scanned-page share is known and the pool is sized to it. The knob is worker
count: the pipeline is embarrassingly parallel per page span, so hitting the
target is a provisioning decision, not an architectural one.

Two things in that table are the difference between 10 minutes and 3 hours, and
both are currently wrong in the app:

- **Docling runs OCR only where there is no text layer.** Running the full
  layout+OCR pipeline over all 50k pages is the hours-long version.
- **Embeddings must batch.** Titan v2 on Bedrock takes **one text per request** —
  150k sequential round-trips is over an hour no matter how you parallelize it.
  `voyage-law-2` takes 128 texts per request, is also 1024-dim (so the column,
  the index, and every existing query stay identical), and is already wired in
  your ETL pipeline. Titan stays as the fallback for single-query embedding at
  search time, where one text per request is exactly right.

## Why Docling

Docling converts a PDF straight to structured markdown — headings, reading
order, tables as real markdown tables, figures captioned — with page provenance
on every element. That gives three things the current path cannot:

- **Markdown, not a text blob.** Headings survive, so chunking can split on
  document structure instead of character count.
- **Tables as tables.** TableFormer output beats any per-page VLM transcription
  on exhibit schedules, damages tables, and dosage charts.
- **Page provenance per element**, so every chunk keeps an exact page anchor and
  citations stay verifiable.

It is Python/PyTorch, so it cannot run in the app server — it runs in the worker
pool you already operate for the ETL pipeline.

## Pipeline

```text
upload ──► scratch.documents ──► one job per 50-page span
                                        │
        ┌───────────────────────────────┴──────────────────────────┐
        │ queue A: text-layer spans        queue B: scanned spans   │
        │   docling, ocr=off                 docling, ocr=on (GPU)  │
        └───────────────────────────────┬──────────────────────────┘
                                        │  markdown + provenance
                          chunk on headings (~1,200 tok, 15% overlap)
                                        │
                          voyage-law-2, 128 chunks/request
                                        │
                          COPY into scratch.chunks ─► build HNSW
                                        │
browser ◄── progress from scratch.jobs (pages done / total, per stage)
```

Span-level jobs claimed with `FOR UPDATE SKIP LOCKED`, exactly like
`run_batch.py`. A page is routed to queue B when pypdfium reports no usable text
layer — a free check that costs milliseconds per page.

## Storage: temporary by construction

New `scratch` schema in the corpus Postgres. Nothing touches the S3 matters
bucket.

```text
scratch.sessions   id, label, owner, created_at, expires_at, status
scratch.documents  session_id, name, sha256, pages, bytes (bytea), bytes_expires_at
scratch.pages      document_id, page_no, source (text|ocr), markdown, elements jsonb
scratch.chunks     page range, heading path, content, embedding vector(1024), tsv
scratch.jobs       span, queue, state, attempts, claimed_by, claimed_at
```

- **Raw PDF bytes**: nulled as soon as a document's spans all complete —
  typically minutes — with a hard 6-hour ceiling.
- **Markdown, chunks, vectors**: 3-day rolling expiry, refreshed on access.
- A `pg_cron` sweep every 15 minutes enforces both. Deleting a session is one
  statement; there is no bucket lifecycle to trust.

## Retrieval

- **Vector**: `hnsw (embedding vector_cosine_ops)` — 1024 dims indexes directly,
  no halfvec cast.
- **Word search**: Postgres `tsvector` with a GIN index, which is the exact-term
  arm — Bates numbers, docket cites, party names, statute cites. Vectors alone
  reliably miss these.
- **Fusion**: reciprocal-rank fusion over both arms, then the existing rerank
  pass over the top candidates.
- **Structure filters**: heading path and `elements` metadata narrow before
  ranking ("tables in expert reports mentioning dosage").
- Chunks carry page ranges, so every answer cites a page you can open.

## Accuracy

- Docling emits per-element confidence; pages below the floor are re-read by
  the Bedrock VL model and the two outputs are diffed. Divergent documents are
  flagged rather than silently indexed.
- Coverage is reported: pages by source (text layer / OCR / failed). "412 of
  50,000 pages unreadable" is visible in the UI.
- `sha256` per document short-circuits re-ingest inside the 3-day window.

## Cost per 50,000-page load

Docling on your own worker box is compute you already pay for. Voyage
embeddings for ~35M tokens land around $2-4. VL re-reads on the low-confidence
slice add a few dollars. **Under $10 per full load**, versus $15-30 for the
per-page VLM approach — and it is faster and more structured.

## Technical notes

- `supabase/corpus/scratch-corpus.sql` — schema above, HNSW + GIN indexes,
  grants, `pg_cron` sweep for both clocks.
- `scripts/pipeline/scratch_worker.py` — claims spans, runs Docling with the
  right pipeline per queue, chunks on headings, batch-embeds, `COPY`s rows.
  Reuses `run_batch.py` claim/heartbeat/backoff conventions.
- `scripts/pipeline/scratch-worker@.service` — sibling of `etl-worker@.service`;
  queue B units pinned to the GPU host.
- `requirements`: `docling`, `pypdfium2` on the worker host only. Nothing new in
  the app bundle.
- `src/routes/api/pile/scratch/*` — create session, stream upload, progress
  poll, search, ask, delete.
- `src/lib/pile/scratch.server.ts` — session lifecycle and hybrid retrieval.
- `src/lib/use-pile.ts` — upload and progress only. The client OCR fan-out and
  its concurrency constants are deleted, which is also what ends the `ERR_SSL`
  storm.
- Reused: `titan.server.ts` (query-time embedding), `vl-ocr.server.ts`
  (confidence re-reads), `rerank.server.ts`, `passages.ts`, `text-quality.ts`.
- Requires a worker host with a GPU for queue B at this scale. CPU-only OCR is
  roughly 5x slower and pushes a 20%-scanned 50k load toward 40 minutes.

## Verification

Time a staged load — 500 pages, then 5,000, then 50,000 — and record
pages/second per stage against the budget table, so any shortfall is attributed
to a specific stage rather than guessed at. Then check markdown fidelity on 20
sampled pages per source, table extraction on a known exhibit schedule,
citation page-accuracy, and that `pg_cron` removes an expired session.
