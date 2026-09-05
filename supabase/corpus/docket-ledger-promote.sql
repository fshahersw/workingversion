-- Promote an authoritative docket ledger into canonical registry tables.
-- The importer scopes registry.docket_ledger_staging to one matter per run.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO registry.releases (
  release_id, schema_version, manifest_status, validation_status,
  manifest_sha256, manifest, predecessor_release_id, built_at, loaded_at, promoted_at
)
SELECT 'docket-ledger-v1', 'batch1-release-manifest.v1', 'successor', 'pass',
       encode(sha256('docket-ledger-v1'::bytea), 'hex'),
       jsonb_build_object('source', 'authoritative-docket-ledger', 'scope', 'dates+titles+document-inventory'),
       'local-backfill-v1', now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM registry.releases WHERE release_id = 'docket-ledger-v1');

-- Insert missing numbered entries and stable synthetic keys for unnumbered events.
WITH missing AS (
  SELECT DISTINCT ON (s.matter_id, s.entry_key)
         s.*, gen_random_uuid() AS new_entry_id, gen_random_uuid() AS new_record_id
  FROM registry.docket_ledger_staging s
  WHERE NOT EXISTS (
    SELECT 1 FROM registry.docket_entries e
    WHERE e.matter_id = s.matter_id AND e.entry_number = s.entry_key
  )
  ORDER BY s.matter_id, s.entry_key, s.attachment_number NULLS FIRST
), records AS (
  INSERT INTO registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    effective_at, observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  SELECT new_record_id, 'docket_entries', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('ledger-entry-' || matter_id || '-' || entry_key)::bytea), 'hex'),
         date_filed, now(), 'docket-ledger-v1', 'docket-ledger-v1', true, now()
  FROM missing
  RETURNING record_id
)
INSERT INTO registry.docket_entries (
  docket_entry_id, record_id, matter_id, entry_number, description, date_filed, text_source
)
SELECT new_entry_id, new_record_id, matter_id, entry_key, title, date_filed,
       'docket-ledger:' || source_document_id
FROM missing;

-- The main ledger row is authoritative for each numbered docket entry.
UPDATE registry.docket_entries e
SET date_filed = s.date_filed,
    description = s.title,
    text_source = 'docket-ledger:' || s.source_document_id
FROM registry.docket_ledger_staging s
WHERE NOT s.is_unnumbered
  AND s.attachment_number IS NULL
  AND e.matter_id = s.matter_id
  AND e.entry_number = s.entry_key;

-- Refresh unnumbered events as well; this also makes reruns idempotent.
UPDATE registry.docket_entries e
SET date_filed = s.date_filed,
    description = s.title,
    text_source = 'docket-ledger:' || s.source_document_id
FROM registry.docket_ledger_staging s
WHERE s.is_unnumbered
  AND e.matter_id = s.matter_id
  AND e.entry_number = s.entry_key;

-- Update all matched document rows without touching storage metadata.
UPDATE registry.documents d
SET entry_date_filed = s.date_filed,
    description = s.title,
    text_source = 'docket-ledger:' || s.source_document_id
FROM registry.docket_ledger_staging s
WHERE NOT s.is_unnumbered
  AND d.matter_id = s.matter_id
  AND d.entry_number = s.entry_number
  AND coalesce(d.attachment_number, 0) = coalesce(s.attachment_number, 0);

-- Insert ledger-only document metadata. These remain unavailable until a PDF is matched.
WITH missing AS (
  SELECT s.*, e.docket_entry_id,
         gen_random_uuid() AS new_document_id, gen_random_uuid() AS new_record_id
  FROM registry.docket_ledger_staging s
  JOIN registry.docket_entries e
    ON e.matter_id = s.matter_id AND e.entry_number = s.entry_key
  WHERE NOT s.is_unnumbered
    AND NOT EXISTS (
      SELECT 1 FROM registry.documents d
      WHERE d.matter_id = s.matter_id
        AND d.entry_number = s.entry_number
        AND coalesce(d.attachment_number, 0) = coalesce(s.attachment_number, 0)
    )
), records AS (
  INSERT INTO registry.records (
    record_id, dataset_name, schema_version, record_status, identity_sha256,
    effective_at, observed_at, first_seen_release_id, last_seen_release_id, is_current, loaded_at
  )
  SELECT new_record_id, 'documents', 'batch1-release-manifest.v1', 'active',
         encode(sha256(('ledger-doc-' || matter_id || '-' || source_document_id)::bytea), 'hex'),
         date_filed, now(), 'docket-ledger-v1', 'docket-ledger-v1', true, now()
  FROM missing
  RETURNING record_id
)
INSERT INTO registry.documents (
  document_id, record_id, matter_id, docket_entry_id, doc_uid, description,
  verification_status, doc_source, entry_number, attachment_number,
  entry_date_filed, is_available, is_sealed, text_source
)
SELECT new_document_id, new_record_id, matter_id, docket_entry_id, source_document_id, title,
       'metadata-only', 'docket-ledger', entry_number, attachment_number,
       date_filed, false, false, 'docket-ledger:' || source_document_id
FROM missing;

-- Keep the strongest row for duplicate slots and flag redundant rows without deletion.
WITH ranked AS (
  SELECT d.document_id,
         row_number() OVER (
           PARTITION BY d.matter_id, d.entry_number, coalesce(d.attachment_number, 0)
           ORDER BY (nullif(d.s3_key, '') IS NOT NULL) DESC,
                    (d.sha256 IS NOT NULL) DESC,
                    length(coalesce(d.description, '')) DESC,
                    d.document_id
         ) AS rank
  FROM registry.documents d
  WHERE d.matter_id IN (SELECT DISTINCT matter_id FROM registry.docket_ledger_staging)
)
UPDATE registry.documents d
SET verification_status = CASE WHEN r.rank > 1 THEN 'duplicate' ELSE d.verification_status END
FROM ranked r
WHERE r.document_id = d.document_id;

-- Fill categories that are still absent after the authoritative title update.
UPDATE registry.documents d
SET doc_category = CASE
  WHEN d.description ~* 'transcript' THEN 'transcript'
  WHEN d.description ~* '\m(order|judgment|opinion)\M' THEN 'order'
  WHEN d.description ~* '\mmotion\M|petition' THEN 'motion'
  WHEN d.description ~* '\mbrief\M|memorandum of law|opposition|reply' THEN 'brief'
  WHEN d.description ~* 'complaint' THEN 'complaint'
  WHEN d.description ~* 'declaration|affidavit|certification' THEN 'declaration'
  WHEN d.description ~* 'exhibit|appendix|attachment' THEN 'exhibit'
  WHEN d.description ~* '\mnotice\M' THEN 'notice'
  WHEN d.description ~* '\mletter\M' THEN 'letter'
  ELSE 'other'
END
WHERE d.matter_id IN (SELECT DISTINCT matter_id FROM registry.docket_ledger_staging)
  AND d.doc_category IS NULL;

UPDATE registry.docket_entries e
SET document_count = agg.count,
    has_pdf = agg.has_pdf,
    page_count = coalesce(agg.pages, e.page_count)
FROM (
  SELECT docket_entry_id, count(*) AS count,
         bool_or(nullif(s3_key, '') IS NOT NULL) AS has_pdf,
         nullif(sum(coalesce(page_count, 0)), 0) AS pages
  FROM registry.documents
  WHERE docket_entry_id IS NOT NULL
    AND matter_id IN (SELECT DISTINCT matter_id FROM registry.docket_ledger_staging)
    AND verification_status IS DISTINCT FROM 'duplicate'
  GROUP BY docket_entry_id
) agg
WHERE e.docket_entry_id = agg.docket_entry_id;

COMMIT;

SELECT m.case_name,
       count(DISTINCT e.docket_entry_id) AS entries,
       count(DISTINCT d.document_id) AS documents,
       count(DISTINCT d.document_id) FILTER (WHERE d.entry_date_filed IS NULL) AS documents_missing_dates,
       count(DISTINCT e.docket_entry_id) FILTER (WHERE e.date_filed IS NULL) AS entries_missing_dates
FROM registry.matters m
LEFT JOIN registry.docket_entries e USING (matter_id)
LEFT JOIN registry.documents d USING (matter_id)
WHERE m.matter_id IN (SELECT DISTINCT matter_id FROM registry.docket_ledger_staging)
GROUP BY m.case_name;