# Rebuild the corpus: simple schema, one bucket, one matter at a time

## My take: yes — with one amendment

Your instinct is right. The registry database I just audited has **37 tables**, and most of the weight is scaffolding, not data:

- `records` (677k rows), `provenance` (86k), `source_records` (40k), `releases`/`release_datasets`/`load_runs` — a provenance model built for a loader pipeline that no longer exists.
- `enrich_documents` (308k) + `enrich_entries` (205k) — sidecar tables that **duplicate** the canonical tables even after promotion, plus four more staging tables (`cl_staging_*`, `docket_ledger_staging`, `meta_repair_staging`, `local_staging_*`).
- `citations` and `opinions` — created, never populated (0 rows).
- 4,159 matters, but only ~1,040 have any documents; the app carries overlay code (`enrich.server.ts`, `sidecar.server.ts`) just to paper over the gaps.
- And the thing you actually want next — RAG over filing text — exists **nowhere**: no text layer, no chunks, no embeddings in any table.

A clean rebuild designed around one idea — *a matter is a folder of PDFs + a docket ledger + extracted text* — is strictly simpler than continuing to patch this. And you're right that it's cheaper now than after we build RAG on top of the current shape.

**The amendment: don't wipe first.** Build the new schema and bucket *alongside* the old registry, prove the pipeline end-to-end on Apple (we can verify every number against your local 333 PDFs), cut the app over, and only then drop the old tables. Zero data-loss window, and the old registry plus `kb-staging`/`FORAWS` stay available as migration sources for every matter we haven't rebuilt yet.

**Locked decisions from your feedback:** no Lovable AI anywhere (embeddings, transcription, agents all run on your own provider keys), vectors live in pgvector **inside the corpus database**, and the Matters list page is replaced by an MDL selector + dense matter workspace.

## The new schema (8 tables instead of 37)

New schema `corpus` in the same corpus database:

| Table | Purpose |
|---|---|
| `matters` | One row per docket: name, docket number, court, judge, status, filed/terminated dates, MDL parent link, CourtListener id/URL |
| `docket_entries` | `entry_number` as a real **integer** (sorting bug dies at the source), `date_filed`, description, page count |
| `documents` | FK to entry, attachment number, title, sha256, bytes, pages, storage key, sealed flag, `doc_type`, `text_status` |
| `parties` / `counsel` | Name, role, firm, attorney — flat, no separate attorney/firm/judge dimension tables |
| `doc_chunks` | RAG layer: chunk text + pgvector embedding + filter metadata (below) |
| `ingest_runs` | Pipeline state per matter: `skeleton → matched → stored → extracted → embedded → verified` |

Gone: releases, records, provenance, review queue, sidecars, staging. Provenance becomes two plain columns (`source`, `source_url`) on each row.

### Chunk metadata — decided up front, drives agent filtering

Every chunk carries structured fields so agents filter with SQL **before** vector similarity:

- `matter_id`, `document_id`, `entry_number`, `attachment_number` — scope a query to one matter or one filing
- `doc_type` — motion / order / opinion / brief / exhibit / transcript / correspondence (from the filing classifier we already built)
- `date_filed`, `page_start`, `page_end` — date-range filtering and page-precise citations
- `is_sealed`, `party_names text[]` — confidentiality handling and party scoping

Agent flow: structured pre-filter → vector similarity inside that subset → every result cites matter, docket entry, and page span.

## The new bucket: `matters`

One bucket in the same S3-compatible storage that hosts the current ones, with a layout that is the convention:

```text
matters/apple-smartphone-md-3113/pdf/0133-000.pdf      ← entry 133, main doc
matters/apple-smartphone-md-3113/pdf/0140-003.pdf      ← entry 140, attachment 3
matters/apple-smartphone-md-3113/text/0133-000.txt     ← extracted text
```

Key = entry + attachment, so a PDF's location is derivable from the database row and vice versa. No more `sha256/` blob paths that need a lookup table.

## The pipeline (one command per matter, resumable, idempotent)

`scripts/pipeline/ingest_matter.py <matter-slug>`, built from the proven pieces of the backfill scripts we already wrote:

1. **Skeleton** — pull the authoritative docket (CourtListener RECAP, or your local ledger CSV when you have one) → `docket_entries` with real dates and integer entry numbers.
2. **Match** — find PDFs for each entry+attachment slot, from your local folder first, then `kb-staging`, then `FORAWS`. Dry-run report before anything is written (the match report you approved for the Apple upload becomes a built-in stage).
3. **Store** — copy/upload into `matters/<slug>/pdf/`, computing sha256, bytes, and page counts as files stream through.
4. **Write rows** — upsert on (matter, entry, attachment); re-runs converge, never duplicate.
5. **Extract** — pull the text layer from every PDF into `text/`, chunk it, embed into `doc_chunks`. **Embeddings via Voyage AI** (`voyage-3-large`, Anthropic's embeddings partner — one new `VOYAGE_API_KEY` secret you provide). Nothing touches Lovable AI.
6. **Verify (quality gate)** — a matter only goes *live* when: 100% of entries have date + description, every non-terminology entry has a PDF, hash/page-count coverage is complete, and text extraction succeeded. The gate output is the coverage CSV you're used to.
7. **Publish** — flip `ingest_runs` to `verified`; the matter appears in the app.

## App cutover — MDL selector + matter workspace

- **The Matters list page goes away.** The sidebar gets an **MDL selector** item instead: click it and a command-style modal (search-as-you-type) lists the matters live in the new corpus; selecting one loads the workspace. Per-user matter entitlements slot in later with your auth workflow — for now the modal lists every verified matter.
- **Matter workspace** (`/matters/$matterId`) becomes a dense, compact page in the style of your reference mockup: slim header strip (caption, docket no., court, presiding judge, status pill, last-synced), then tabs — for now exactly two:
  - **Matter** — the filing ledger: dense rows (date · dkt # · entry text · type chip), filing-type filter chips, a search-this-matter field, and a right rail with the case card (court / presiding / filed / party counts), upcoming deadlines, and parties & counsel.
  - **Documents** — the document register with file-type filtering (motions, orders, exhibits, transcripts, correspondence) and an **in-page viewer**: clicking a row smoothly expands the PDF inline (animated panel, signed URL from the `matters` bucket) and collapses without losing scroll position. Dense, compact rows, aligned columns — reference-mockup density, our brand.
- `corpus.server.ts` readers point at `corpus.*`; newest-first numeric sort is native (integer entry numbers).
- `enrich.server.ts` and `sidecar.server.ts` get **deleted** — one canonical source, no overlay.
- Agent tools gain the real win: `search_filings_text` doing metadata-filtered vector search over `doc_chunks` alongside docket-text search — actual RAG over filing contents, not just docket titles.
- Corpus Health swaps review-queue noise for per-matter pipeline state.
- **Dictation reroute:** the mic feature currently transcribes through the Lovable gateway; it moves to a direct provider key (Gemini API key or Whisper — your pick when we get there, it's a small swap behind `transcribeAudio`).

## Sequencing

1. **Phase 0** — DDL + `matters` bucket + pipeline scaffold + Voyage key wired.
2. **Phase 1 — Apple pilot.** Your local 333 PDFs are the first input (this absorbs the 222-gap upload already in flight). Ships with the MDL selector + two-tab workspace + in-page viewer running against the pilot matter. We verify every count against your folder before calling it done.
3. **Phase 2 — Insulin + Roundup**, sourced from existing registry/S3 data via the same pipeline (no re-download from CourtListener).
4. **Phase 3** — remaining matters by priority (your Seeger Weiss top-50 list), sourced from catalog + `kb-staging` + bulk parquet.
5. **Phase 4** — after parity checks, drop the old `registry` schema objects and sidecars.

Nothing is deleted until the matter it belongs to is live in the new world and spot-checked.

## Technical notes

- All DDL runs against the corpus Postgres via `CORPUS_DB_URL`; scripts live under `scripts/pipeline/`, idempotent and resumable like the backfill scripts.
- `pgvector` extension enabled in the corpus database; `doc_chunks.embedding` indexed with HNSW for fast filtered similarity.
- Old buckets are never written to by the new pipeline — read-only sources.
- The app's multi-bucket presigner already exists, so serving PDFs from `matters` is a config-level change, not new code.
- Workspace UI reuses existing tokens (brand navy/blue-soft, white background) and shadcn `cmdk`-style command dialog for the selector; the in-page viewer animates with framer-motion, consistent with the chat polish pass.
