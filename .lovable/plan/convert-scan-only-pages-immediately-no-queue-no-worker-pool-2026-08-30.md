# Convert scan-only pages immediately — no queue, no worker pool

Pages with no text layer must never sit in a queue waiting for a machine someone has to
remember to start. They get converted inline, during ingest, in the same session.

Everything needed for this already exists in the codebase and is currently unused by the
Summarize flow:

- `src/lib/pile-render.ts` — rasterizes specific PDF pages to JPEG in the browser.
- `src/routes/api/pile/ocr.ts` — per-page OCR endpoint.
- `src/lib/pile/vl-ocr.server.ts` — Nemotron Nano VL on Bedrock, tuned for PACER pages.

That path was shelved because firing ~12–32 concurrent base64 JSON posts per file blew
up the TLS connection (`ERR_SSL_BAD_RECORD_MAC_ALERT`). The fix is transport discipline,
not a different architecture.

## The design

### 1. Only truly scanned pages qualify

Replace the `isLowQualityText` trigger (threshold 0.55 — it flags normal PACER text
layers) with an empty-text test: a page qualifies for OCR only when extraction yields
essentially nothing (under ~120 characters). On your 778-page file this collapses 11
flagged OCR spans down to the handful of pages that are really images.

### 2. Convert them inline, immediately, with a small pipe

For each qualifying page: rasterize → POST → merge the returned text into the page,
live, as each one lands.

- Send the JPEG as **raw binary** (`application/octet-stream`) instead of a base64 JSON
  body — roughly a third fewer bytes and no giant JSON strings.
- Cap in-flight OCR requests at **4** (down from 12–32), globally across all files.
  This is what killed the connection before.
- Keep AIMD: back off to 2 on a 429/5xx, creep back up to 6 max on sustained success.
- Bounded retry per page (3 tries, jittered backoff, honor `Retry-After`); a page that
  still fails is marked unreadable rather than failing the run.

### 3. Hard budget so a huge scan batch can't hang the session

Cap inline OCR at 400 pages per session (existing `OCR_PAGE_CAP`). Past that, the extra
pages are reported as "not converted (over inline limit)" and the rest of the pile stays
fully usable. No silent waiting.

### 4. Retire the scratch queue from the ingest path

The Docling/scratch upload becomes unused by Summarize: no session creation, no binary
slice upload, no polling for the common case. The tables, worker script, and endpoints
stay in the repo for a future bulk (50k-page) job, but nothing in the UI depends on a
worker being alive.

### 5. Honest progress

The reasoning rail shows: pages read locally, scanned pages found, `k / n converted`
ticking live, and a final line for anything unreadable. No more `0/778`.

## Technical notes

- `src/lib/use-pile.ts` — replace the `createScratchWorkspace`/`uploadScratchDocument`/
  `awaitScratchConversion` block with `forEachRenderedPdfPage` + a bounded `mapPool` of
  OCR calls that merge into `pagesRef` / `pageTexts` as they resolve.
- `src/routes/api/pile/ocr.ts` — accept `application/octet-stream` (base64-encode
  server-side before the Bedrock call) while keeping the JSON body for compatibility.
- `src/lib/pile/limits.ts` — `OCR_CONCURRENCY` 12 → 4, `MIN` 4 → 2, `MAX` 32 → 6;
  add `OCR_EMPTY_CHARS = 120`.
- `src/components/summarize/ReasoningRail.tsx` — step detail wording.
- No schema, worker, or backend deployment change. Bedrock creds are already configured.
