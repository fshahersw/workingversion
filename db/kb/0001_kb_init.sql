-- ============================================================================
-- KB 0001 — per-user document knowledge base (Aurora PostgreSQL + pgvector).
--
-- This is the FIRST app-owned relational/vector store on the AWS-native stack.
-- It is SEPARATE from all legacy Postgres (Supabase primary + corpus are being
-- retired). Apply against the Aurora Serverless v2 KB cluster only.
--
-- Tenancy: every row is owned by a Cognito principal (id-token `sub`) and scoped
-- to a workspace + surface. Isolation is enforced by FORCED row-level security
-- keyed on the `app.user` GUC, which the server sets per request from the
-- verified principal (see db/kb/README.md). Queries ALSO pass owner/workspace
-- explicitly (belt and suspenders).
--
-- Idempotent: safe to re-run. No Supabase/PostgREST constructs (no auth.uid(),
-- no service_role, no pgrst schema exposure) — this DB is reached directly by
-- the app via the RDS Data API, not PostgREST.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS kb;

-- Least-privilege application role. The RDS Data API secret should authenticate
-- as this role (NOT the cluster master) so FORCE RLS actually constrains it.
-- Password/IAM auth is configured out-of-band; this only ensures the role and
-- its grants exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_app') THEN
    CREATE ROLE kb_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA kb TO kb_app;

-- --- updated_at maintenance --------------------------------------------------

CREATE OR REPLACE FUNCTION kb.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- --- documents ---------------------------------------------------------------
-- One row per uploaded file. Page text / BDA markdown lives in S3 (s3_key);
-- only metadata + status live here. sha256 dedups per (owner, workspace).

CREATE TABLE IF NOT EXISTS kb.documents (
  doc_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub     text NOT NULL,
  workspace_id  uuid NOT NULL,
  surface       text NOT NULL,                 -- workingset | deposition | review
  file_name     text NOT NULL,
  mime          text,
  sha256        text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size     bigint,
  page_count    integer,
  s3_key        text,                           -- durable page markdown/text (SSE-KMS)
  converter     text,                           -- bda | sheetjs | text | vl
  status        text NOT NULL DEFAULT 'queued', -- queued|converting|embedding|ready|error
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_sub, workspace_id, sha256)
);

CREATE INDEX IF NOT EXISTS kb_documents_scope_idx
  ON kb.documents (owner_sub, workspace_id, surface, updated_at DESC);

DROP TRIGGER IF EXISTS kb_documents_updated_at ON kb.documents;
CREATE TRIGGER kb_documents_updated_at BEFORE UPDATE ON kb.documents
  FOR EACH ROW EXECUTE FUNCTION kb.set_updated_at();

-- --- chunks ------------------------------------------------------------------
-- Page-anchored, table-aware chunks. `content` is verbatim (displayed + quoted);
-- `context` is the contextual-retrieval prefix used ONLY for embedding/lexical
-- recall. `tsv` is generated over content+context for the BM25 leg. `embedding`
-- is Titan v2 (1024-dim, cosine).

CREATE TABLE IF NOT EXISTS kb.chunks (
  chunk_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id        uuid NOT NULL REFERENCES kb.documents(doc_id) ON DELETE CASCADE,
  owner_sub     text NOT NULL,
  workspace_id  uuid NOT NULL,
  surface       text NOT NULL,
  chunk_index   integer NOT NULL,
  page_start    integer,
  page_end      integer,
  kind          text,                           -- para | table | heading | list | figure
  content       text NOT NULL,
  context       text,
  conf          real,                           -- extraction confidence 0..1
  token_count   integer,
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english',
                    coalesce(content, '') || ' ' || coalesce(context, ''))
                ) STORED,
  embedding     vector(1024),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS kb_chunks_scope_idx
  ON kb.chunks (owner_sub, workspace_id, surface);
CREATE INDEX IF NOT EXISTS kb_chunks_doc_idx
  ON kb.chunks (doc_id);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx
  ON kb.chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
  ON kb.chunks USING hnsw (embedding vector_cosine_ops);

-- --- hybrid search (RRF fuse of vector kNN + BM25, one round trip) -----------
-- Mirrors the proven corpus hybrid pattern but scoped to a single tenant and
-- surface, with an optional doc-id restrict list ("search only these files").
-- SECURITY INVOKER (default) so FORCE RLS still applies as defense in depth.
-- NOTE (v2): global RRF here; per-file candidate pooling (so a 5k-page doc
-- can't crowd out a short exhibit) is a later refinement.

CREATE OR REPLACE FUNCTION kb.hybrid_search(
  p_owner      text,
  p_workspace  uuid,
  p_surface    text,
  p_query      text,
  p_embedding  vector(1024),
  p_match      integer DEFAULT 150,
  p_rrf_k      integer DEFAULT 60,
  p_doc_ids    uuid[]  DEFAULT NULL
) RETURNS TABLE (
  chunk_id    bigint,
  doc_id      uuid,
  page_start  integer,
  page_end    integer,
  kind        text,
  content     text,
  conf        real,
  score       double precision
)
LANGUAGE sql STABLE AS $$
  WITH vec AS (
    SELECT c.chunk_id,
           row_number() OVER (ORDER BY c.embedding <=> p_embedding) AS rk
    FROM kb.chunks c
    WHERE c.owner_sub = p_owner
      AND c.workspace_id = p_workspace
      AND c.surface = p_surface
      AND c.embedding IS NOT NULL
      AND p_embedding IS NOT NULL
      AND (p_doc_ids IS NULL OR c.doc_id = ANY(p_doc_ids))
    ORDER BY c.embedding <=> p_embedding
    LIMIT p_match
  ),
  lex AS (
    SELECT c.chunk_id,
           row_number() OVER (
             ORDER BY ts_rank(c.tsv, plainto_tsquery('english', p_query)) DESC
           ) AS rk
    FROM kb.chunks c
    WHERE c.owner_sub = p_owner
      AND c.workspace_id = p_workspace
      AND c.surface = p_surface
      AND c.tsv @@ plainto_tsquery('english', p_query)
      AND (p_doc_ids IS NULL OR c.doc_id = ANY(p_doc_ids))
    ORDER BY ts_rank(c.tsv, plainto_tsquery('english', p_query)) DESC
    LIMIT p_match
  ),
  fused AS (
    SELECT COALESCE(v.chunk_id, l.chunk_id) AS chunk_id,
           COALESCE(1.0 / (p_rrf_k + v.rk), 0.0)
         + COALESCE(1.0 / (p_rrf_k + l.rk), 0.0) AS rrf
    FROM vec v
    FULL OUTER JOIN lex l ON v.chunk_id = l.chunk_id
  )
  SELECT c.chunk_id, c.doc_id, c.page_start, c.page_end, c.kind, c.content,
         c.conf, f.rrf AS score
  FROM fused f
  JOIN kb.chunks c ON c.chunk_id = f.chunk_id
  ORDER BY f.rrf DESC
  LIMIT p_match;
$$;

-- --- grants + FORCED row-level security --------------------------------------
-- FORCE RLS so the policy applies even when the connecting role owns the table.
-- Default-deny: current_setting('app.user', true) returns NULL when unset, and
-- `owner_sub = NULL` is never true, so an unscoped connection sees nothing.

GRANT SELECT, INSERT, UPDATE, DELETE ON kb.documents TO kb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kb.chunks    TO kb_app;
GRANT EXECUTE ON FUNCTION kb.hybrid_search(
  text, uuid, text, text, vector, integer, integer, uuid[]
) TO kb_app;

ALTER TABLE kb.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb.documents FORCE  ROW LEVEL SECURITY;
ALTER TABLE kb.chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb.chunks    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_documents_tenant ON kb.documents;
CREATE POLICY kb_documents_tenant ON kb.documents
  USING (owner_sub = current_setting('app.user', true))
  WITH CHECK (owner_sub = current_setting('app.user', true));

DROP POLICY IF EXISTS kb_chunks_tenant ON kb.chunks;
CREATE POLICY kb_chunks_tenant ON kb.chunks
  USING (owner_sub = current_setting('app.user', true))
  WITH CHECK (owner_sub = current_setting('app.user', true));

-- Shared workspaces (P5) will extend the USING clause with an OR against a
-- membership relation; owner-only for now.
