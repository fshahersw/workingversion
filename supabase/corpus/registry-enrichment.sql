-- ===========================================================================
-- Litigation registry — enrichment sidecar
-- Run this ONCE in the corpus project's SQL editor (project odwhzepghulspdzmzhhz).
--
-- Additive only. It does not touch registry.documents, registry.docket_entries
-- or registry.matters; your loader pipeline keeps full ownership of those.
-- Everything lives in the existing `registry` schema (already exposed to the
-- Data API), prefixed enrich_ so the two never collide.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Documents backfilled from object storage (catalog/documents.json + PDFs)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.enrich_documents (
  doc_uid              text PRIMARY KEY,
  matter_id            uuid,
  docket_id            bigint NOT NULL,
  entry_number         integer,
  document_number      text,
  attachment_number    integer,
  entry_date_filed     date,
  entry_description    text,
  document_description text,
  doc_category         text,
  document_type        integer,
  high_value           boolean NOT NULL DEFAULT false,
  page_count           integer,
  file_size            bigint,
  is_available         boolean NOT NULL DEFAULT true,
  is_sealed            boolean NOT NULL DEFAULT false,
  pacer_doc_id         text,
  courtlistener_url    text,
  download_url         text,
  sha1                 text,
  s3_bucket            text,
  s3_key               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrich_documents_matter_idx  ON registry.enrich_documents (matter_id);
CREATE INDEX IF NOT EXISTS enrich_documents_docket_idx  ON registry.enrich_documents (docket_id, entry_number);
CREATE INDEX IF NOT EXISTS enrich_documents_haspdf_idx  ON registry.enrich_documents (matter_id) WHERE s3_key IS NOT NULL;

-- --------------------------------------------------------------------------
-- Docket entries as the catalog sees them (true filing dates, full text)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.enrich_entries (
  entry_uid         text PRIMARY KEY,          -- '<docket_id>-<entry_number>'
  matter_id         uuid,
  docket_id         bigint NOT NULL,
  entry_number      integer NOT NULL,
  entry_date_filed  date,
  entry_description text,
  document_count    integer NOT NULL DEFAULT 0,
  page_count        integer,
  has_pdf           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrich_entries_matter_idx ON registry.enrich_entries (matter_id, entry_number);
CREATE INDEX IF NOT EXISTS enrich_entries_docket_idx ON registry.enrich_entries (docket_id, entry_number);

-- --------------------------------------------------------------------------
-- Audit trail for each backfill run
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.enrich_load_runs (
  run_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text NOT NULL DEFAULT 'running',
  source             text,
  dockets_matched    integer NOT NULL DEFAULT 0,
  dockets_unmatched  integer NOT NULL DEFAULT 0,
  documents_upserted integer NOT NULL DEFAULT 0,
  entries_upserted   integer NOT NULL DEFAULT 0,
  pdfs_linked        integer NOT NULL DEFAULT 0,
  notes              jsonb,
  error              text
);

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION registry.enrich_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = registry, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enrich_documents_touch ON registry.enrich_documents;
CREATE TRIGGER enrich_documents_touch
  BEFORE UPDATE ON registry.enrich_documents
  FOR EACH ROW EXECUTE FUNCTION registry.enrich_touch_updated_at();

DROP TRIGGER IF EXISTS enrich_entries_touch ON registry.enrich_entries;
CREATE TRIGGER enrich_entries_touch
  BEFORE UPDATE ON registry.enrich_entries
  FOR EACH ROW EXECUTE FUNCTION registry.enrich_touch_updated_at();

-- --------------------------------------------------------------------------
-- Data API access. The app reads with the service key only (server side);
-- anon/authenticated get nothing.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA registry TO service_role;
GRANT ALL ON registry.enrich_documents  TO service_role;
GRANT ALL ON registry.enrich_entries    TO service_role;
GRANT ALL ON registry.enrich_load_runs  TO service_role;

ALTER TABLE registry.enrich_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.enrich_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.enrich_load_runs  ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) may read or write.

-- --------------------------------------------------------------------------
-- Convenience view: registry documents + backfilled documents in one shape
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW registry.enrich_coverage AS
SELECT
  m.matter_id,
  m.case_name,
  m.docket_number,
  (SELECT count(*) FROM registry.documents d          WHERE d.matter_id = m.matter_id) AS registry_documents,
  (SELECT count(*) FROM registry.enrich_documents e   WHERE e.matter_id = m.matter_id) AS backfilled_documents,
  (SELECT count(*) FROM registry.enrich_documents e   WHERE e.matter_id = m.matter_id AND e.s3_key IS NOT NULL) AS staged_pdfs,
  (SELECT count(*) FROM registry.enrich_entries  x    WHERE x.matter_id = m.matter_id) AS backfilled_entries
FROM registry.matters m;

GRANT SELECT ON registry.enrich_coverage TO service_role;
