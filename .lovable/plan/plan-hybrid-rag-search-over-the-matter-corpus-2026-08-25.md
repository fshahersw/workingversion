# Plan: Hybrid RAG Search Over the Matter Corpus

Give the in-house agent loop high-quality retrieval over filed document text: **hybrid semantic + keyword search** with RRF fusion, metadata pre-filtering, and lawyer-grade pinpoint citations (docket entry + page range) that render in the existing source panel. Works for Apple today; Insulin and Roundup get it automatically as their embed stages complete.

## Why hybrid (not pure vector)

Legal retrieval has two failure modes: vector search misses exact tokens (docket numbers, party names, case/statute citations like "780 F.3d 123"), keyword search misses concepts ("arguments about standing"). Running both legs and fusing with **Reciprocal Rank Fusion** (`1/(60+rank)` per leg, summed) is the standard robust fix — no score-normalization tuning required.

## Schema audit (current v2 state)

Strong already: filterable metadata columns (`matter_id`, `doc_type`, `date_filed`, `is_sealed`), HNSW cosine index on 1024-dim vectors, page pinpoints, sealed exclusion, `match_doc_chunks` with metadata filters.

Gaps this plan closes:
1. **No keyword leg** — `doc_chunks` has no `tsvector` column or GIN index (registry GIN indexes cover docket-entry text only, not document content)
2. **Missing agent filters** — no `entry_number` / `document_id` / `party` filter params (agents can't scope "search within Dkt. 1542 only")
3. **HNSW under selective filters** — matter-scoped queries post-filter the index scan; enable `hnsw.iterative_scan` when pgvector ≥ 0.8
4. **No chunk overlap** — `chunk_pages` splits pages with no overlap; boundary-spanning answers can clip. Deferred (requires re-chunk + re-embed); noted as a future option, not blocking.

## What exists already (verified)

- `corpus.doc_chunks`: Apple's chunks, `embedding vector(1024)` (voyage-law-2), HNSW index, metadata columns. Embed stage at 2,880/4,427 (~65%), ~15 min remaining.
- `corpus.match_doc_chunks()` in the `corpus` schema — not PostgREST-reachable; the app reads v2 data through `public.corpus_*` bridge views with `CORPUS_SERVICE_KEY`.
- Agent tools today: `search_matters`, `get_matter`, `search_filings` (keyword, docket-entry level), `list_documents`, `web_search`. No document-content search.
- `VOYAGE_API_KEY` already stored; writer cites `[S#]`; source panel + sentence highlighting already render `Source` objects — **no frontend changes**.

## Build steps

### 1. Database — `supabase/corpus/corpus-v2.2.sql` (apply to the external corpus DB)
- Add stored generated column `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` + GIN index on `corpus.doc_chunks`.
- New `corpus.hybrid_match_chunks(query_embedding vector(1024), query_text text, match_count, filter_matter, filter_doc_type, filter_entry, filter_document, filter_party, filter_date_from, filter_date_to, min_similarity)`:
  - **Vector leg**: top `match_count*4` by `embedding <=> query` (with similarity floor)
  - **Keyword leg**: top `match_count*4` by `ts_rank_cd(content_tsv, websearch_to_tsquery('english', query_text))` (`websearch_to_tsquery` handles quotes/phrases safely from agent input)
  - **Fusion**: full outer join, RRF score `1/(60+rank)` per leg, order by combined score, limit
  - All existing filters plus new `filter_entry`, `filter_document`, `filter_party` (`party_names` array contains, case-insensitive)
  - Check pgvector version; if ≥ 0.8, `SET hnsw.iterative_scan = strict_order` inside the function for correct filtered scans
- Public wrapper `public.corpus_hybrid_match_chunks` joining `documents` + `matters` to also return `case_name`, `docket_number`, `description`, `s3_key`, `courtlistener_url` for citations. `GRANT EXECUTE TO service_role` only.

### 2. Server retrieval layer — new `src/lib/rag.server.ts`
- `embedQuery(text)` — Voyage `/v1/embeddings`, `voyage-law-2`, `input_type: "query"` (pipeline indexed with `"document"`; the asymmetry is required), bounded 429 backoff, fail-soft.
- `hybridSearch({ query, mode, matterId?, docType?, entryNumber?, documentId?, party?, dateFrom?, dateTo?, limit })` — embed (skipped in `keyword` mode), POST `${CORPUS_URL}/rest/v1/rpc/corpus_hybrid_match_chunks` with the service key.
- `rerank(query, candidates)` — optional second stage via Voyage `rerank-2.5` (`/v1/rerank`, same key): hybrid top-24 → rerank → top 8. Enabled by default for agent calls; flag to disable if latency matters.
- `readDocument({ documentId, pageStart?, pageEnd? })` — consecutive chunks of one document ordered by `chunk_index` for "read the full section" follow-ups.

### 3. Agent tools — extend `src/lib/agents/tools.server.ts`
- **`search_document_text`** (new): inputs `query`, `mode` (`hybrid` default / `semantic` / `keyword`), `matter_id`, `doc_type`, `entry_number`, `party`, `date_from/to`, `limit` (default 8, max 20). Each hit registers a `Source`:
  - citation: `*In re Apple…*, No. 5:18-md-02827, Dkt. 1542.1, pp. 3–5 — <description>`
  - `source_url`: stored PDF via `corpusFileUrl(s3_key)` + `#page=N` (CourtListener URL fallback for gap docs)
  - `section_path`: `Dkt. N pp. X–Y`, `effective_date`: `date_filed`, `content`: full chunk text (tool output truncated ~1,500 chars; source keeps full text for highlighting)
- **`read_document`** (new): full page range of one document by `document_id`.
- Assignments: `filings_documents` gets both; `case_law` gets `search_document_text`; `docket_research` gets `search_document_text`. `search_filings` stays for docket-entry-level scans.

### 4. Prompts — `src/lib/agents/prompts.ts`
- Filings agent: prefer `search_document_text` for content questions; use `search_filings` for docket-level procedural scans; resolve matter via `search_matters` first, then scope with `matter_id`; use `entry_number`/`party` filters for pinpoint follow-ups.
- Writer: filings citations carry docket entry + page pinpoints.

### 5. Verification
- After Apple's embed completes: scripted A/B — same query in `semantic` vs `hybrid` mode (e.g. "class certification standing" vs exact-token query "Dkt. 1542 Daubert"), confirm keyword leg surfaces exact-token hits vector alone misses, and vice versa.
- Confirm matter scoping, similarity floors, and that citations resolve to stored PDFs.
- Full chat query in the preview: sources render with pinpoints, sentence highlighting matches chunk text.
- Gate: `chunks_embedded = 4427`, stage `embedded`.

## Not in scope
- No frontend/UI changes; no SSE contract or model lineup changes; no ingest pipeline changes.
- Chunk-overlap re-chunking (needs a re-embed) — revisit after retrieval quality testing.
- Weighted-score fusion tuning — RRF k=60 default; tune only if A/B tests show skew.
