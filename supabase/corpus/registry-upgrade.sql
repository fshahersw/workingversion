-- Run this in the LITIGATION REGISTRY project (schema: registry).
-- Companion to registry-scale.sql. Everything here is additive and safe to
-- re-run. The app works without it and gets materially better with it.
--
--   1. sortable / date-aware docket entries
--   2. per-matter stats used by the Matters list count columns
--   3. corpus health + review summary views used by the Corpus Health page
--
-- After each ingest run:
--   SELECT registry.refresh_docket_entry_derived();
--   REFRESH MATERIALIZED VIEW CONCURRENTLY registry.matter_stats;

-- 1. Sortable entry numbers + parsed entry dates ------------------------------
-- entry_number is text ("999" sorts above "1000") and there is no date column;
-- 93% of entries carry "(Entered: MM/DD/YYYY)" at the end of the description.

ALTER TABLE registry.docket_entries
  ADD COLUMN IF NOT EXISTS entry_number_int integer
    GENERATED ALWAYS AS (NULLIF(regexp_replace(entry_number, '\D', '', 'g'), '')::integer) STORED;

ALTER TABLE registry.docket_entries
  ADD COLUMN IF NOT EXISTS entered_at date;

CREATE OR REPLACE FUNCTION registry.refresh_docket_entry_derived()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE n bigint;
BEGIN
  WITH parsed AS (
    SELECT docket_entry_id,
           to_date((regexp_match(description, '\(Entered:\s*(\d{2}/\d{2}/\d{4})\)'))[1], 'MM/DD/YYYY') AS d
    FROM registry.docket_entries
    WHERE entered_at IS NULL
      AND description ~ '\(Entered:\s*\d{2}/\d{2}/\d{4}\)'
  )
  UPDATE registry.docket_entries e
     SET entered_at = p.d
    FROM parsed p
   WHERE e.docket_entry_id = p.docket_entry_id AND p.d IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

SELECT registry.refresh_docket_entry_derived();

CREATE INDEX IF NOT EXISTS docket_entries_matter_entry_int_idx
  ON registry.docket_entries (matter_id, entry_number_int);
CREATE INDEX IF NOT EXISTS docket_entries_entered_at_idx
  ON registry.docket_entries (entered_at);

-- 2. Per-matter stats ----------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS registry.matter_stats;

CREATE MATERIALIZED VIEW registry.matter_stats AS
SELECT
  m.matter_id,
  (SELECT count(*) FROM registry.parties            p WHERE p.matter_id = m.matter_id) AS party_count,
  (SELECT count(*) FROM registry.counsel_appearances c WHERE c.matter_id = m.matter_id) AS counsel_count,
  (SELECT count(*) FROM registry.docket_entries     d WHERE d.matter_id = m.matter_id) AS docket_entry_count,
  (SELECT count(*) FROM registry.documents          o WHERE o.matter_id = m.matter_id) AS document_count,
  (SELECT count(*) FROM registry.matter_relationships r
     WHERE r.to_matter_id = m.matter_id AND r.relationship_type = 'member_of_mdl')     AS member_count,
  (SELECT min(d.entered_at) FROM registry.docket_entries d WHERE d.matter_id = m.matter_id) AS first_entered,
  (SELECT max(d.entered_at) FROM registry.docket_entries d WHERE d.matter_id = m.matter_id) AS last_entered
FROM registry.matters m;

CREATE UNIQUE INDEX matter_stats_pkey ON registry.matter_stats (matter_id);

-- 3. Corpus health -------------------------------------------------------------
-- One row: how much of the corpus is actually populated, per matter role.

CREATE OR REPLACE VIEW registry.coverage_summary AS
SELECT
  m.node_role,
  count(*)                                             AS matters,
  count(*) FILTER (WHERE s.docket_entry_count > 0)     AS with_entries,
  count(*) FILTER (WHERE s.document_count     > 0)     AS with_documents,
  count(*) FILTER (WHERE s.party_count        > 0)     AS with_parties,
  count(*) FILTER (WHERE s.counsel_count      > 0)     AS with_counsel,
  sum(s.docket_entry_count)                            AS docket_entries,
  sum(s.document_count)                                AS documents
FROM registry.matters m
JOIN registry.matter_stats s USING (matter_id)
GROUP BY m.node_role;

CREATE OR REPLACE VIEW registry.review_summary AS
SELECT review_type, status, reason_code, count(*)::bigint AS count
FROM registry.review_records
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW registry.storage_summary AS
SELECT s3_bucket,
       count(*)::bigint          AS documents,
       sum(byte_count)::bigint   AS bytes,
       count(*) FILTER (WHERE verification_status <> 'verified')::bigint AS unverified
FROM registry.documents
GROUP BY s3_bucket;

-- Attachment count per docket entry (used by the filing register)
CREATE OR REPLACE VIEW registry.docket_entry_document_counts AS
SELECT docket_entry_id, count(*)::int AS document_count
FROM registry.documents
WHERE docket_entry_id IS NOT NULL
GROUP BY docket_entry_id;

-- 4. Search indexes ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS matters_case_name_trgm_idx
  ON registry.matters USING gin (case_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS docket_entries_description_trgm_idx
  ON registry.docket_entries USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_matter_idx        ON registry.documents (matter_id);
CREATE INDEX IF NOT EXISTS documents_docket_entry_idx  ON registry.documents (docket_entry_id);
CREATE INDEX IF NOT EXISTS parties_matter_idx          ON registry.parties (matter_id);
CREATE INDEX IF NOT EXISTS counsel_matter_idx          ON registry.counsel_appearances (matter_id);

-- 5. Data API access -----------------------------------------------------------

GRANT USAGE ON SCHEMA registry TO service_role, authenticated;
GRANT SELECT ON registry.matter_stats,
                registry.coverage_summary,
                registry.review_summary,
                registry.storage_summary,
                registry.docket_entry_document_counts
  TO service_role, authenticated;
