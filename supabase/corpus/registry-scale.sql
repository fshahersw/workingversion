-- Run this in the LITIGATION REGISTRY Supabase project (schema: registry).
-- It is optional for correctness — the app works without it — but it makes the
-- Matters list and filing register fast at 2,500+ matters, and it is what turns
-- the per-matter count columns (parties / entries / docs / members) back on.

-- 1. Indexes for the query shapes the app issues -----------------------------

CREATE INDEX IF NOT EXISTS docket_entries_matter_entry_idx
  ON registry.docket_entries (matter_id, entry_number);

CREATE INDEX IF NOT EXISTS documents_matter_idx
  ON registry.documents (matter_id);

CREATE INDEX IF NOT EXISTS documents_docket_entry_idx
  ON registry.documents (docket_entry_id);

CREATE INDEX IF NOT EXISTS parties_matter_idx
  ON registry.parties (matter_id);

CREATE INDEX IF NOT EXISTS counsel_appearances_matter_idx
  ON registry.counsel_appearances (matter_id);

CREATE INDEX IF NOT EXISTS judicial_assignments_matter_idx
  ON registry.judicial_assignments (matter_id);

CREATE INDEX IF NOT EXISTS matter_relationships_from_idx
  ON registry.matter_relationships (from_matter_id);

CREATE INDEX IF NOT EXISTS matter_relationships_to_idx
  ON registry.matter_relationships (to_matter_id, relationship_type);

CREATE INDEX IF NOT EXISTS matters_court_idx  ON registry.matters (court_id);
CREATE INDEX IF NOT EXISTS matters_status_idx ON registry.matters (case_status);
CREATE INDEX IF NOT EXISTS matters_name_idx   ON registry.matters (case_name);

-- Fast ILIKE search on case names and docket text
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS matters_case_name_trgm_idx
  ON registry.matters USING gin (case_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS docket_entries_description_trgm_idx
  ON registry.docket_entries USING gin (description gin_trgm_ops);

-- 2. Per-matter counts, read as one row instead of scanning the corpus -------
-- Materialized so the list page never aggregates 38k+ rows. Refresh it after
-- each ingest run:  REFRESH MATERIALIZED VIEW CONCURRENTLY registry.matter_stats;

DROP MATERIALIZED VIEW IF EXISTS registry.matter_stats;

CREATE MATERIALIZED VIEW registry.matter_stats AS
SELECT
  m.matter_id,
  (SELECT count(*) FROM registry.parties         p WHERE p.matter_id = m.matter_id) AS party_count,
  (SELECT count(*) FROM registry.docket_entries  d WHERE d.matter_id = m.matter_id) AS docket_entry_count,
  (SELECT count(*) FROM registry.documents       o WHERE o.matter_id = m.matter_id) AS document_count,
  (SELECT count(*) FROM registry.matter_relationships r
     WHERE r.to_matter_id = m.matter_id AND r.relationship_type = 'member_of_mdl') AS member_count
FROM registry.matters m;

CREATE UNIQUE INDEX matter_stats_pkey ON registry.matter_stats (matter_id);

-- 3. Attachment count per docket entry ---------------------------------------

DROP VIEW IF EXISTS registry.docket_entry_document_counts;

CREATE VIEW registry.docket_entry_document_counts AS
SELECT docket_entry_id, count(*)::int AS document_count
FROM registry.documents
WHERE docket_entry_id IS NOT NULL
GROUP BY docket_entry_id;

-- 4. Data API access ----------------------------------------------------------
-- The app reads the registry with the service key, but grant the usual roles so
-- PostgREST exposes the objects consistently.

GRANT USAGE ON SCHEMA registry TO service_role, authenticated;
GRANT SELECT ON registry.matter_stats TO service_role, authenticated;
GRANT SELECT ON registry.docket_entry_document_counts TO service_role, authenticated;
