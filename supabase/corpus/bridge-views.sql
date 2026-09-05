-- ============================================================================
-- Public bridge views over the `corpus` schema.
--
-- The app talks to PostgREST with the default `public` profile, so every
-- corpus table the app reads is exposed here as a read-only view. This file is
-- the single authoritative definition of all six views: do not redefine any of
-- them elsewhere.
--
-- Idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/bridge-views.sql
--
-- Access model: the views run with owner privileges and the underlying
-- corpus.* tables have no RLS policies, so these views are the entire access
-- surface. Only `service_role` may read them; every app read path
-- (workspace.server.ts, agents/corpus-v2.server.ts, rag.server.ts) uses the
-- corpus service key. `anon`/`authenticated` get nothing — the publishable
-- corpus key is used for storage signed URLs only.
-- ============================================================================

CREATE OR REPLACE VIEW public.corpus_matters AS
SELECT
  matter_id,
  slug,
  case_name,
  short_name,
  docket_number,
  court_id,
  court_name,
  judge,
  status,
  stage,
  node_role,
  mdl_number,
  date_filed,
  date_terminated,
  lead_counsel,
  courtlistener_docket_id,
  courtlistener_url,
  pipeline_stage,
  verified_at,
  last_synced_at,
  source,
  source_url,
  created_at,
  updated_at
FROM corpus.matters;

CREATE OR REPLACE VIEW public.corpus_docket_entries AS
SELECT
  docket_entry_id,
  matter_id,
  entry_number,
  date_filed,
  description,
  entry_type,
  page_count,
  document_count,
  has_pdf,
  source,
  source_url,
  created_at,
  updated_at,
  entry_label,
  docket_source,
  display_number,
  display_label_pretty,
  sort_seq,
  source_docket_number
FROM corpus.docket_entries;

CREATE OR REPLACE VIEW public.corpus_documents AS
SELECT
  document_id,
  matter_id,
  docket_entry_id,
  entry_number,
  attachment_number,
  title,
  doc_type,
  doc_category,
  sha256,
  byte_count,
  page_count,
  s3_bucket,
  s3_key,
  is_sealed,
  text_status,
  courtlistener_url,
  pacer_doc_id,
  source,
  source_url,
  created_at,
  updated_at,
  entry_label,
  docket_source,
  display_number,
  display_label_pretty,
  sort_seq,
  source_docket_number
FROM corpus.documents;

CREATE OR REPLACE VIEW public.corpus_parties AS
SELECT
  party_id,
  matter_id,
  name,
  party_type,
  created_at
FROM corpus.parties;

CREATE OR REPLACE VIEW public.corpus_counsel AS
SELECT
  counsel_id,
  matter_id,
  party_name,
  attorney,
  firm,
  role,
  created_at
FROM corpus.counsel;

CREATE OR REPLACE VIEW public.corpus_ingest_runs AS
SELECT
  run_id,
  matter_id,
  slug,
  stage,
  status,
  detail,
  started_at,
  finished_at
FROM corpus.ingest_runs;

-- --- Access: service_role read-only -----------------------------------------

REVOKE ALL ON public.corpus_matters        FROM anon, authenticated;
REVOKE ALL ON public.corpus_docket_entries FROM anon, authenticated;
REVOKE ALL ON public.corpus_documents      FROM anon, authenticated;
REVOKE ALL ON public.corpus_parties        FROM anon, authenticated;
REVOKE ALL ON public.corpus_counsel        FROM anon, authenticated;
REVOKE ALL ON public.corpus_ingest_runs    FROM anon, authenticated;

REVOKE ALL ON public.corpus_matters        FROM service_role;
REVOKE ALL ON public.corpus_docket_entries FROM service_role;
REVOKE ALL ON public.corpus_documents      FROM service_role;
REVOKE ALL ON public.corpus_parties        FROM service_role;
REVOKE ALL ON public.corpus_counsel        FROM service_role;
REVOKE ALL ON public.corpus_ingest_runs    FROM service_role;

GRANT SELECT ON public.corpus_matters        TO service_role;
GRANT SELECT ON public.corpus_docket_entries TO service_role;
GRANT SELECT ON public.corpus_documents      TO service_role;
GRANT SELECT ON public.corpus_parties        TO service_role;
GRANT SELECT ON public.corpus_counsel        TO service_role;
GRANT SELECT ON public.corpus_ingest_runs    TO service_role;
