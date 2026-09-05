-- ============================================================================
-- Trigram indexes for agent/registry search.
--
-- The research agents match docket entry text and case names with token-based
-- ILIKE substring searches. Without trigram indexes those queries sequentially
-- scan ~209k docket entries and ~1k matters on every tool call.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS docket_entries_description_trgm_idx
  ON registry.docket_entries USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS matters_case_name_trgm_idx
  ON registry.matters USING gin (case_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS matters_docket_number_trgm_idx
  ON registry.matters USING gin (docket_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS matters_matter_key_trgm_idx
  ON registry.matters USING gin (matter_key gin_trgm_ops);

CREATE INDEX IF NOT EXISTS documents_description_trgm_idx
  ON registry.documents USING gin (description gin_trgm_ops);

ANALYZE registry.docket_entries;
ANALYZE registry.matters;
ANALYZE registry.documents;
