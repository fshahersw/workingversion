-- ============================================================================
-- Corpus v2: the clean rebuild. Run against the corpus Postgres (CORPUS_DB_URL).
-- 8 tables replace the 37-table registry accretion. Idempotent.
--
--   matters / docket_entries / documents / parties / counsel
--   doc_chunks (pgvector RAG layer) / ingest_runs
--
-- Access model: the app reads with the service key through PostgREST
-- (Accept-Profile: corpus). RLS is enabled with no anon/authenticated
-- policies — server-side only by construction.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS corpus;

-- 1. Matters -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.matters (
  matter_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text NOT NULL UNIQUE,           -- apple-smartphone-md-3113
  case_name              text NOT NULL,
  short_name             text,                           -- "Apple Smartphone"
  docket_number          text NOT NULL,
  court_id               text NOT NULL,
  court_name             text,
  judge                  text,
  status                 text,                           -- active / terminated
  stage                  text,                           -- bellwether / discovery / ...
  node_role              text,                           -- mdl_master / mdl_member / public_docket
  mdl_number             text,
  date_filed             date,
  date_terminated        date,
  lead_counsel           text[],
  courtlistener_docket_id bigint,
  courtlistener_url      text,
  pipeline_stage         text NOT NULL DEFAULT 'new',    -- skeleton→matched→stored→extracted→embedded→verified
  verified_at            timestamptz,
  last_synced_at         timestamptz,
  source                 text NOT NULL DEFAULT 'courtlistener',
  source_url             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- 2. Docket entries ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.docket_entries (
  docket_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id       uuid NOT NULL REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  entry_number    integer NOT NULL,                      -- real integer: numeric sort is native
  entry_label     text NOT NULL DEFAULT '',              -- raw label ("133", "T5") for display
  date_filed      date,
  description     text NOT NULL DEFAULT '',
  entry_type      text,                                  -- motion/order/opinion/brief/...
  page_count      integer,
  document_count  integer NOT NULL DEFAULT 0,
  has_pdf         boolean NOT NULL DEFAULT false,
  source          text,
  source_url      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, entry_number)
);

CREATE INDEX IF NOT EXISTS v2_entries_matter_num_idx  ON corpus.docket_entries (matter_id, entry_number DESC);
CREATE INDEX IF NOT EXISTS v2_entries_matter_date_idx ON corpus.docket_entries (matter_id, date_filed DESC);
CREATE INDEX IF NOT EXISTS v2_entries_desc_trgm_idx   ON corpus.docket_entries USING gin (description gin_trgm_ops);

-- 3. Documents -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.documents (
  document_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id         uuid NOT NULL REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  docket_entry_id   uuid REFERENCES corpus.docket_entries(docket_entry_id) ON DELETE SET NULL,
  entry_number      integer,
  entry_label       text NOT NULL DEFAULT '',
  attachment_number integer NOT NULL DEFAULT 0,
  title             text NOT NULL DEFAULT '',
  doc_type          text,
  doc_category      text,
  sha256            text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_count        bigint,
  page_count        integer,
  s3_bucket         text,
  s3_key            text,
  is_sealed         boolean NOT NULL DEFAULT false,
  text_status       text NOT NULL DEFAULT 'pending',     -- pending/extracted/no_text/failed
  courtlistener_url text,
  pacer_doc_id      text,
  source            text,
  source_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, entry_number, attachment_number)
);

CREATE INDEX IF NOT EXISTS v2_documents_entry_idx   ON corpus.documents (docket_entry_id);
CREATE INDEX IF NOT EXISTS v2_documents_matter_idx  ON corpus.documents (matter_id, entry_number DESC, attachment_number);
CREATE INDEX IF NOT EXISTS v2_documents_sha256_idx  ON corpus.documents (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS v2_documents_title_trgm_idx ON corpus.documents USING gin (title gin_trgm_ops);

-- 4. Parties / counsel (flat — no dimension tables) ---------------------------

CREATE TABLE IF NOT EXISTS corpus.parties (
  party_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id   uuid NOT NULL REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  name        text NOT NULL,
  party_type  text,                                      -- plaintiff / defendant / intervenor / ...
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, name, party_type)
);

CREATE TABLE IF NOT EXISTS corpus.counsel (
  counsel_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id   uuid NOT NULL REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  party_name  text,
  attorney    text NOT NULL,
  firm        text,
  role        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, attorney, firm, party_name)
);

CREATE INDEX IF NOT EXISTS v2_parties_matter_idx ON corpus.parties (matter_id);
CREATE INDEX IF NOT EXISTS v2_counsel_matter_idx ON corpus.counsel (matter_id);

-- 5. doc_chunks — the RAG layer ------------------------------------------------
-- voyage-3-large embeddings: 1024 dimensions. Metadata columns exist so agents
-- filter with SQL before vector similarity.

CREATE TABLE IF NOT EXISTS corpus.doc_chunks (
  chunk_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id         uuid NOT NULL REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  document_id       uuid NOT NULL REFERENCES corpus.documents(document_id) ON DELETE CASCADE,
  docket_entry_id   uuid REFERENCES corpus.docket_entries(docket_entry_id) ON DELETE SET NULL,
  entry_number      integer,
  attachment_number integer,
  chunk_index       integer NOT NULL,
  page_start        integer,
  page_end          integer,
  doc_type          text,
  date_filed        date,
  is_sealed         boolean NOT NULL DEFAULT false,
  party_names       text[],
  content           text NOT NULL,
  token_count       integer,
  embedding         extensions.vector(1024),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS v2_chunks_document_idx ON corpus.doc_chunks (document_id);
CREATE INDEX IF NOT EXISTS v2_chunks_matter_idx   ON corpus.doc_chunks (matter_id, doc_type);
CREATE INDEX IF NOT EXISTS v2_chunks_embedding_hnsw ON corpus.doc_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Metadata-filtered similarity search, callable via PostgREST RPC.
CREATE OR REPLACE FUNCTION corpus.match_doc_chunks(
  query_embedding  extensions.vector(1024),
  match_count      integer DEFAULT 12,
  filter_matter    uuid    DEFAULT NULL,
  filter_doc_type  text    DEFAULT NULL,
  filter_date_from date    DEFAULT NULL,
  filter_date_to   date    DEFAULT NULL
) RETURNS TABLE (
  chunk_id uuid, document_id uuid, matter_id uuid,
  entry_number integer, attachment_number integer,
  page_start integer, page_end integer,
  doc_type text, date_filed date, content text, similarity double precision
)
LANGUAGE sql STABLE AS $$
  SELECT c.chunk_id, c.document_id, c.matter_id, c.entry_number, c.attachment_number,
         c.page_start, c.page_end, c.doc_type, c.date_filed, c.content,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM corpus.doc_chunks c
  WHERE c.embedding IS NOT NULL
    AND NOT c.is_sealed
    AND (filter_matter    IS NULL OR c.matter_id = filter_matter)
    AND (filter_doc_type  IS NULL OR c.doc_type  = filter_doc_type)
    AND (filter_date_from IS NULL OR c.date_filed >= filter_date_from)
    AND (filter_date_to   IS NULL OR c.date_filed <= filter_date_to)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 6. ingest_runs — pipeline state ----------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.ingest_runs (
  run_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id   uuid REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  slug        text NOT NULL,
  stage       text NOT NULL,                             -- skeleton/match/store/write/extract/embed/verify
  status      text NOT NULL,                             -- running/done/error
  detail      jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS v2_ingest_slug_idx ON corpus.ingest_runs (slug, stage, started_at DESC);

-- updated_at maintenance -------------------------------------------------------

CREATE OR REPLACE FUNCTION corpus.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS v2_matters_updated_at   ON corpus.matters;
DROP TRIGGER IF EXISTS v2_entries_updated_at   ON corpus.docket_entries;
DROP TRIGGER IF EXISTS v2_documents_updated_at ON corpus.documents;
CREATE TRIGGER v2_matters_updated_at   BEFORE UPDATE ON corpus.matters        FOR EACH ROW EXECUTE FUNCTION corpus.set_updated_at();
CREATE TRIGGER v2_entries_updated_at   BEFORE UPDATE ON corpus.docket_entries FOR EACH ROW EXECUTE FUNCTION corpus.set_updated_at();
CREATE TRIGGER v2_documents_updated_at BEFORE UPDATE ON corpus.documents      FOR EACH ROW EXECUTE FUNCTION corpus.set_updated_at();

-- Access -----------------------------------------------------------------------
-- Server-side only: the app reads with the service key (RLS bypass). No anon
-- or authenticated policies — nothing in this schema is reachable from the
-- browser by construction.

GRANT USAGE ON SCHEMA corpus TO service_role, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA corpus TO service_role;
GRANT EXECUTE ON FUNCTION corpus.match_doc_chunks TO service_role;

ALTER TABLE corpus.matters        ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.docket_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.parties        ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.counsel        ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.doc_chunks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.ingest_runs    ENABLE ROW LEVEL SECURITY;

-- Expose the schema to the Data API alongside registry.
DO $$
DECLARE current_schemas text;
BEGIN
  SELECT current_setting('pgrst.db_schemas', true) INTO current_schemas;
  IF current_schemas IS NULL OR current_schemas = '' THEN
    current_schemas := 'public, registry';
  END IF;
  IF position('corpus' in current_schemas) = 0 THEN
    EXECUTE format('ALTER DATABASE %I SET pgrst.db_schemas = %L',
                   current_database(), current_schemas || ', corpus');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
