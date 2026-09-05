-- ============================================================================
-- Corpus v2.2 — hybrid retrieval layer
--   1. Keyword leg: stored tsvector + GIN on doc_chunks.content
--   2. corpus.hybrid_match_chunks: vector + keyword legs fused with RRF
--   3. public.corpus_hybrid_match_chunks: PostgREST-reachable wrapper that
--      joins documents/matters for citation fields
-- Server-side only: granted to service_role, which bypasses RLS.
-- ============================================================================

-- 1. Keyword leg ----------------------------------------------------------------

ALTER TABLE corpus.doc_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS v2_chunks_tsv_gin
  ON corpus.doc_chunks USING gin (content_tsv);

-- Narrow scoped-search filters agents actually use.
CREATE INDEX IF NOT EXISTS v2_chunks_entry_idx
  ON corpus.doc_chunks (matter_id, entry_number);

-- 2. Hybrid match ---------------------------------------------------------------
-- Vector leg: cosine over the HNSW index (top 4x, optional similarity floor).
-- Keyword leg: ts_rank_cd over websearch_to_tsquery (top 4x).
-- Fusion: Reciprocal Rank Fusion, 1/(60+rank) per leg. Either leg may be
-- skipped by passing NULL for its input.

CREATE OR REPLACE FUNCTION corpus.hybrid_match_chunks(
  query_embedding  extensions.vector(1024) DEFAULT NULL,
  query_text       text    DEFAULT NULL,
  match_count      integer DEFAULT 8,
  filter_matter    uuid    DEFAULT NULL,
  filter_doc_type  text    DEFAULT NULL,
  filter_entry     integer DEFAULT NULL,
  filter_document  uuid    DEFAULT NULL,
  filter_party     text    DEFAULT NULL,
  filter_date_from date    DEFAULT NULL,
  filter_date_to   date    DEFAULT NULL,
  min_similarity   double precision DEFAULT 0.0
) RETURNS TABLE (
  chunk_id uuid, document_id uuid, matter_id uuid,
  entry_number integer, attachment_number integer,
  page_start integer, page_end integer,
  doc_type text, date_filed date, content text,
  rrf_score double precision, vector_rank bigint, keyword_rank bigint,
  similarity double precision
)
LANGUAGE sql STABLE AS $$
WITH base AS (
  SELECT c.chunk_id, c.embedding, c.content_tsv
  FROM corpus.doc_chunks c
  WHERE NOT c.is_sealed
    AND (filter_matter    IS NULL OR c.matter_id = filter_matter)
    AND (filter_doc_type  IS NULL OR c.doc_type = filter_doc_type)
    AND (filter_entry     IS NULL OR c.entry_number = filter_entry)
    AND (filter_document  IS NULL OR c.document_id = filter_document)
    AND (filter_party     IS NULL OR EXISTS (
           SELECT 1 FROM unnest(c.party_names) p
           WHERE p ILIKE '%' || filter_party || '%'))
    AND (filter_date_from IS NULL OR c.date_filed >= filter_date_from)
    AND (filter_date_to   IS NULL OR c.date_filed <= filter_date_to)
),
vec AS (
  SELECT b.chunk_id,
         ROW_NUMBER() OVER (ORDER BY b.embedding <=> query_embedding) AS rank
  FROM base b
  WHERE query_embedding IS NOT NULL
    AND b.embedding IS NOT NULL
    AND (1 - (b.embedding <=> query_embedding)) >= min_similarity
  ORDER BY b.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1) * 4
),
-- Keyword leg: AND match (websearch syntax) ranks first; an OR fallback over
-- the query's lexemes fills in so long conceptual queries never return empty.
q AS (
  SELECT websearch_to_tsquery('english', query_text) AS tsq_and,
         (SELECT to_tsquery('english', string_agg(lexeme, ' | '))
          FROM (SELECT DISTINCT unnest(tsvector_to_array(
                  to_tsvector('english', coalesce(query_text, '')))) AS lexeme
                LIMIT 12) l) AS tsq_or
  WHERE query_text IS NOT NULL AND btrim(query_text) <> ''
),
kw_scored AS (
  SELECT b.chunk_id,
         ts_rank_cd(b.content_tsv, q.tsq_and) AS r_and,
         ts_rank_cd(b.content_tsv, q.tsq_or)  AS r_or
  FROM base b CROSS JOIN q
  WHERE b.content_tsv @@ q.tsq_and OR b.content_tsv @@ q.tsq_or
),
kw AS (
  SELECT chunk_id,
         ROW_NUMBER() OVER (ORDER BY (r_and > 0) DESC, r_and DESC, r_or DESC) AS rank
  FROM kw_scored
  ORDER BY (r_and > 0) DESC, r_and DESC, r_or DESC
  LIMIT GREATEST(match_count, 1) * 4
),
fused AS (
  SELECT COALESCE(v.chunk_id, k.chunk_id) AS chunk_id,
         COALESCE(1.0 / (60 + v.rank), 0.0)
           + COALESCE(1.0 / (60 + k.rank), 0.0) AS rrf_score,
         v.rank AS vector_rank,
         k.rank AS keyword_rank
  FROM vec v FULL OUTER JOIN kw k USING (chunk_id)
)
SELECT c.chunk_id, c.document_id, c.matter_id, c.entry_number, c.attachment_number,
       c.page_start, c.page_end, c.doc_type, c.date_filed, c.content,
       f.rrf_score, f.vector_rank, f.keyword_rank,
       CASE WHEN c.embedding IS NOT NULL AND query_embedding IS NOT NULL
            THEN 1 - (c.embedding <=> query_embedding) END AS similarity
FROM fused f
JOIN corpus.doc_chunks c ON c.chunk_id = f.chunk_id
ORDER BY f.rrf_score DESC
LIMIT GREATEST(match_count, 1);
$$;

-- pgvector 0.8: keep scanning the HNSW graph until filtered LIMIT is satisfied,
-- so matter-scoped searches don't under-return.
ALTER FUNCTION corpus.hybrid_match_chunks(
  extensions.vector(1024), text, integer, uuid, text, integer, uuid, text, date, date, double precision
) SET hnsw.iterative_scan = strict_order;

-- 3. Public wrapper (PostgREST) -------------------------------------------------
-- query_embedding arrives as a JSON string '[0.1,0.2,...]' and is cast here.
-- Joins documents + matters so callers get everything needed for citations.

CREATE OR REPLACE FUNCTION public.corpus_hybrid_match_chunks(
  query_embedding  text    DEFAULT NULL,
  query_text       text    DEFAULT NULL,
  match_count      integer DEFAULT 8,
  filter_matter    uuid    DEFAULT NULL,
  filter_doc_type  text    DEFAULT NULL,
  filter_entry     integer DEFAULT NULL,
  filter_document  uuid    DEFAULT NULL,
  filter_party     text    DEFAULT NULL,
  filter_date_from date    DEFAULT NULL,
  filter_date_to   date    DEFAULT NULL,
  min_similarity   double precision DEFAULT 0.0
) RETURNS TABLE (
  chunk_id uuid, document_id uuid, matter_id uuid,
  entry_number integer, attachment_number integer,
  page_start integer, page_end integer,
  doc_type text, date_filed date, content text,
  rrf_score double precision, vector_rank bigint, keyword_rank bigint,
  similarity double precision,
  case_name text, short_name text, docket_number text, slug text,
  doc_title text, entry_label text, s3_key text, courtlistener_url text
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = corpus, public, extensions
AS $$
  SELECT h.chunk_id, h.document_id, h.matter_id, h.entry_number, h.attachment_number,
         h.page_start, h.page_end, h.doc_type, h.date_filed, h.content,
         h.rrf_score, h.vector_rank, h.keyword_rank, h.similarity,
         m.case_name, m.short_name, m.docket_number, m.slug,
         d.title, d.entry_label, d.s3_key, d.courtlistener_url
  FROM corpus.hybrid_match_chunks(
    CASE WHEN query_embedding IS NULL OR btrim(query_embedding) = ''
         THEN NULL
         ELSE query_embedding::extensions.vector(1024) END,
    query_text, match_count, filter_matter, filter_doc_type, filter_entry,
    filter_document, filter_party, filter_date_from, filter_date_to, min_similarity
  ) h
  JOIN corpus.documents d ON d.document_id = h.document_id
  JOIN corpus.matters  m ON m.matter_id  = h.matter_id;
$$;

-- Access ----------------------------------------------------------------------
-- Server-side only: service_role bypasses RLS. No anon/authenticated grants.

GRANT EXECUTE ON FUNCTION corpus.hybrid_match_chunks(
  extensions.vector(1024), text, integer, uuid, text, integer, uuid, text, date, date, double precision
) TO service_role;
GRANT EXECUTE ON FUNCTION public.corpus_hybrid_match_chunks(
  text, text, integer, uuid, text, integer, uuid, text, date, date, double precision
) TO service_role;

-- 4. Pinpoint read ---------------------------------------------------------------
-- Returns one document's chunks (optionally within a page window) so agents can
-- pull full context around a search hit.

CREATE OR REPLACE FUNCTION corpus.read_document_chunks(
  p_document_id uuid,
  p_page_start  integer DEFAULT NULL,
  p_page_end    integer DEFAULT NULL,
  p_max_chunks  integer DEFAULT 60
) RETURNS TABLE (
  chunk_id uuid, chunk_index integer, page_start integer, page_end integer, content text
)
LANGUAGE sql STABLE AS $$
  SELECT c.chunk_id, c.chunk_index, c.page_start, c.page_end, c.content
  FROM corpus.doc_chunks c
  WHERE c.document_id = p_document_id
    AND c.page_start <= COALESCE(p_page_end, 2147483647)
    AND c.page_end   >= COALESCE(p_page_start, 0)
  ORDER BY c.chunk_index
  LIMIT GREATEST(LEAST(p_max_chunks, 200), 1);
$$;

CREATE OR REPLACE FUNCTION public.corpus_read_document_chunks(
  p_document_id uuid,
  p_page_start  integer DEFAULT NULL,
  p_page_end    integer DEFAULT NULL,
  p_max_chunks  integer DEFAULT 60
) RETURNS TABLE (
  chunk_id uuid, chunk_index integer, page_start integer, page_end integer, content text
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = corpus, public, extensions
AS $$
  SELECT * FROM corpus.read_document_chunks(p_document_id, p_page_start, p_page_end, p_max_chunks);
$$;

GRANT EXECUTE ON FUNCTION public.corpus_read_document_chunks(uuid, integer, integer, integer) TO service_role;
