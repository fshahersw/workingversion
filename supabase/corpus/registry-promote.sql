-- ---------------------------------------------------------------------------
-- Promote the object-storage catalog backfill from the registry.enrich_*
-- sidecar tables into the canonical registry.documents / registry.docket_entries
-- tables, inside the registry's own release + records provenance model.
--
-- Idempotent and re-runnable: keys are deterministic UUIDs derived from the
-- catalog's doc_uid / entry_uid, so a second run is a no-op update.
-- ---------------------------------------------------------------------------

BEGIN;

SET LOCAL search_path = registry, public;
SET LOCAL statement_timeout = '30min';

-- 1. Catalog release ---------------------------------------------------------

INSERT INTO registry.releases (
  release_id, schema_version, manifest_status, validation_status,
  manifest_sha256, manifest, built_at, loaded_at, promoted_at
)
SELECT
  'catalog-backfill-v1',
  COALESCE((SELECT schema_version FROM registry.releases ORDER BY loaded_at DESC NULLS LAST LIMIT 1), '1'),
  COALESCE((SELECT manifest_status FROM registry.releases ORDER BY loaded_at DESC NULLS LAST LIMIT 1), 'complete'),
  'pass',
  md5('catalog-backfill-v1') || md5('catalog-backfill-v1:manifest'),
  jsonb_build_object('source', 'object-storage catalog', 'promoted_from', 'registry.enrich_documents/registry.enrich_entries'),
  now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM registry.releases WHERE release_id = 'catalog-backfill-v1');

-- 2. Relax the load-time constraints the catalog cannot satisfy --------------

ALTER TABLE registry.documents ALTER COLUMN sha256      DROP NOT NULL;
ALTER TABLE registry.documents ALTER COLUMN byte_count  DROP NOT NULL;
ALTER TABLE registry.documents ALTER COLUMN s3_bucket   DROP NOT NULL;
ALTER TABLE registry.documents ALTER COLUMN s3_key      DROP NOT NULL;

-- 3. Catalog-only columns the UI already surfaces ----------------------------

ALTER TABLE registry.documents
  ADD COLUMN IF NOT EXISTS doc_source        text,
  ADD COLUMN IF NOT EXISTS sha1              text,
  ADD COLUMN IF NOT EXISTS page_count        integer,
  ADD COLUMN IF NOT EXISTS entry_date_filed  date,
  ADD COLUMN IF NOT EXISTS entry_number      integer,
  ADD COLUMN IF NOT EXISTS document_number   text,
  ADD COLUMN IF NOT EXISTS attachment_number integer,
  ADD COLUMN IF NOT EXISTS doc_category      text,
  ADD COLUMN IF NOT EXISTS high_value        boolean,
  ADD COLUMN IF NOT EXISTS is_available      boolean,
  ADD COLUMN IF NOT EXISTS is_sealed         boolean,
  ADD COLUMN IF NOT EXISTS pacer_doc_id      text,
  ADD COLUMN IF NOT EXISTS courtlistener_url text,
  ADD COLUMN IF NOT EXISTS download_url      text;

ALTER TABLE registry.docket_entries
  ADD COLUMN IF NOT EXISTS date_filed     date,
  ADD COLUMN IF NOT EXISTS page_count     integer,
  ADD COLUMN IF NOT EXISTS document_count integer,
  ADD COLUMN IF NOT EXISTS has_pdf        boolean;

CREATE INDEX IF NOT EXISTS documents_doc_uid_idx ON registry.documents (doc_uid);
CREATE INDEX IF NOT EXISTS documents_matter_entry_idx ON registry.documents (matter_id, entry_number);

-- 4. Promote docket entries --------------------------------------------------

CREATE TEMP TABLE promote_entries ON COMMIT DROP AS
WITH src AS (
  SELECT DISTINCT ON (e.matter_id, e.entry_number) e.*
  FROM registry.enrich_entries e
  WHERE e.matter_id IS NOT NULL
  ORDER BY e.matter_id, e.entry_number, e.page_count DESC NULLS LAST, e.entry_uid
)
SELECT
  md5('de:'  || src.entry_uid)::uuid AS docket_entry_id,
  md5('der:' || src.entry_uid)::uuid AS record_id,
  md5('de:'  || src.entry_uid) || md5('de2:' || src.entry_uid) AS identity_sha256,
  src.matter_id,
  src.entry_number::text AS entry_number_text,
  src.entry_date_filed,
  src.entry_description,
  src.document_count,
  src.page_count,
  src.has_pdf
FROM src
WHERE NOT EXISTS (
  SELECT 1 FROM registry.docket_entries d
  WHERE d.matter_id = src.matter_id AND d.entry_number = src.entry_number::text
);

INSERT INTO registry.records (
  record_id, dataset_name, schema_version, record_status, source_record_ids,
  identity_sha256, is_current, first_seen_release_id, last_seen_release_id, loaded_at
)
SELECT
  p.record_id, 'docket_entries',
  (SELECT schema_version FROM registry.releases WHERE release_id = 'catalog-backfill-v1'),
  'active', '{}', p.identity_sha256, true,
  'catalog-backfill-v1', 'catalog-backfill-v1', now()
FROM promote_entries p
ON CONFLICT (record_id) DO NOTHING;

INSERT INTO registry.docket_entries (
  docket_entry_id, record_id, matter_id, entry_number, description,
  date_filed, page_count, document_count, has_pdf
)
SELECT
  p.docket_entry_id, p.record_id, p.matter_id, p.entry_number_text, p.entry_description,
  p.entry_date_filed, p.page_count, p.document_count, p.has_pdf
FROM promote_entries p
ON CONFLICT (docket_entry_id) DO NOTHING;

-- Backfill the catalog columns on entries that already existed. The join goes
-- through a temp table with a numeric entry_number so it can use the
-- (matter_id, entry_number) index on the sidecar.
CREATE TEMP TABLE existing_entries ON COMMIT DROP AS
SELECT d.docket_entry_id, d.matter_id, d.entry_number::int AS entry_number_int
FROM registry.docket_entries d
WHERE d.entry_number ~ '^[0-9]{1,9}$'
  AND (d.date_filed IS NULL OR d.page_count IS NULL OR d.document_count IS NULL OR d.has_pdf IS NULL);

CREATE INDEX ON existing_entries (matter_id, entry_number_int);
ANALYZE existing_entries;

UPDATE registry.docket_entries d
SET date_filed     = COALESCE(d.date_filed, e.entry_date_filed),
    page_count     = COALESCE(d.page_count, e.page_count),
    document_count = COALESCE(d.document_count, e.document_count),
    has_pdf        = COALESCE(d.has_pdf, e.has_pdf)
FROM existing_entries x
JOIN registry.enrich_entries e
  ON e.matter_id = x.matter_id AND e.entry_number = x.entry_number_int
WHERE d.docket_entry_id = x.docket_entry_id;


-- 5. Promote documents -------------------------------------------------------

CREATE TEMP TABLE promote_docs ON COMMIT DROP AS
WITH src AS (
  SELECT DISTINCT ON (e.doc_uid) e.*
  FROM registry.enrich_documents e
  WHERE e.matter_id IS NOT NULL
  ORDER BY e.doc_uid
)
SELECT
  md5('doc:'  || src.doc_uid)::uuid AS document_id,
  md5('docr:' || src.doc_uid)::uuid AS record_id,
  md5('doc:'  || src.doc_uid) || md5('doc2:' || src.doc_uid) AS identity_sha256,
  src.*
FROM src
WHERE NOT EXISTS (SELECT 1 FROM registry.documents d WHERE d.doc_uid = src.doc_uid);

INSERT INTO registry.records (
  record_id, dataset_name, schema_version, record_status, source_record_ids,
  identity_sha256, is_current, first_seen_release_id, last_seen_release_id, loaded_at
)
SELECT
  p.record_id, 'documents',
  (SELECT schema_version FROM registry.releases WHERE release_id = 'catalog-backfill-v1'),
  'active', '{}', p.identity_sha256, true,
  'catalog-backfill-v1', 'catalog-backfill-v1', now()
FROM promote_docs p
ON CONFLICT (record_id) DO NOTHING;

INSERT INTO registry.documents (
  document_id, record_id, matter_id, docket_entry_id, doc_uid, description,
  sha256, byte_count, s3_bucket, s3_key, verification_status,
  doc_source, sha1, page_count, entry_date_filed, entry_number, document_number,
  attachment_number, doc_category, high_value, is_available, is_sealed,
  pacer_doc_id, courtlistener_url, download_url
)
SELECT
  p.document_id, p.record_id, p.matter_id,
  de.docket_entry_id,
  p.doc_uid,
  COALESCE(NULLIF(p.document_description, ''), NULLIF(p.entry_description, '')),
  NULL,
  p.file_size,
  p.s3_bucket,
  p.s3_key,
  CASE WHEN p.s3_key IS NOT NULL THEN 'catalog' ELSE 'unverified' END,
  'catalog',
  p.sha1, p.page_count, p.entry_date_filed, p.entry_number, p.document_number,
  p.attachment_number, p.doc_category, p.high_value, p.is_available, p.is_sealed,
  p.pacer_doc_id, p.courtlistener_url, p.download_url
FROM promote_docs p
LEFT JOIN registry.docket_entries de
  ON de.matter_id = p.matter_id AND de.entry_number = p.entry_number::text
ON CONFLICT (document_id) DO NOTHING;

-- Backfill the catalog columns on documents that already existed.
UPDATE registry.documents d
SET page_count        = COALESCE(d.page_count, e.page_count),
    entry_date_filed  = COALESCE(d.entry_date_filed, e.entry_date_filed),
    entry_number      = COALESCE(d.entry_number, e.entry_number),
    document_number   = COALESCE(d.document_number, e.document_number),
    attachment_number = COALESCE(d.attachment_number, e.attachment_number),
    doc_category      = COALESCE(d.doc_category, e.doc_category),
    high_value        = COALESCE(d.high_value, e.high_value),
    is_available      = COALESCE(d.is_available, e.is_available),
    is_sealed         = COALESCE(d.is_sealed, e.is_sealed),
    pacer_doc_id      = COALESCE(d.pacer_doc_id, e.pacer_doc_id),
    courtlistener_url = COALESCE(d.courtlistener_url, e.courtlistener_url),
    download_url      = COALESCE(d.download_url, e.download_url),
    sha1              = COALESCE(d.sha1, e.sha1),
    doc_source        = COALESCE(d.doc_source, 'registry')
FROM registry.enrich_documents e
WHERE e.doc_uid = d.doc_uid
  AND d.doc_source IS DISTINCT FROM 'catalog';


-- 6. Rebuild coverage against the canonical tables ---------------------------

DROP VIEW IF EXISTS registry.enrich_coverage;
CREATE VIEW registry.enrich_coverage AS
SELECT
  m.matter_id,
  (SELECT count(*) FROM registry.documents      d WHERE d.matter_id = m.matter_id) AS documents,
  (SELECT count(*) FROM registry.documents      d WHERE d.matter_id = m.matter_id AND d.s3_key IS NOT NULL) AS staged_pdfs,
  (SELECT count(*) FROM registry.docket_entries x WHERE x.matter_id = m.matter_id) AS docket_entries
FROM registry.matters m;

GRANT SELECT ON registry.enrich_coverage TO anon, authenticated, service_role;

ANALYZE registry.documents;
ANALYZE registry.docket_entries;

COMMIT;
