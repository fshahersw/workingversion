-- Promote computed metadata repairs into registry.documents.
-- Staging is filled by scripts/backfill/repair_metadata.py; this script is idempotent.

CREATE TABLE IF NOT EXISTS registry.meta_repair_staging (
  document_id       uuid PRIMARY KEY,
  attachment_number integer,
  description       text,
  doc_category      text,
  entry_date_filed  date,
  page_count        integer,
  byte_count        bigint,
  sha256            text,
  is_duplicate      boolean DEFAULT false,
  source_note       text
);

UPDATE registry.documents d
SET
  attachment_number = coalesce(s.attachment_number, d.attachment_number),
  description       = CASE
                        WHEN s.description IS NOT NULL
                         AND length(btrim(s.description)) > length(btrim(coalesce(d.description, '')))
                        THEN s.description ELSE d.description END,
  doc_category      = coalesce(d.doc_category, s.doc_category),
  entry_date_filed  = coalesce(d.entry_date_filed, s.entry_date_filed),
  page_count        = coalesce(d.page_count, s.page_count),
  byte_count        = coalesce(d.byte_count, s.byte_count),
  sha256            = coalesce(d.sha256, s.sha256),
  verification_status = CASE
                          WHEN s.is_duplicate THEN 'duplicate'
                          ELSE d.verification_status END
FROM registry.meta_repair_staging s
WHERE s.document_id = d.document_id;

-- Keep docket entry descriptions in sync when the entry is blank but its main
-- document now carries text.
UPDATE registry.docket_entries e
SET description = d.description
FROM registry.documents d
WHERE d.docket_entry_id = e.docket_entry_id
  AND coalesce(d.attachment_number, 0) = 0
  AND (e.description IS NULL OR btrim(e.description) = '')
  AND d.description IS NOT NULL
  AND btrim(d.description) <> '';

-- Refresh entry-level rollups.
UPDATE registry.docket_entries e
SET document_count = agg.n,
    has_pdf        = agg.any_pdf,
    page_count     = coalesce(agg.pages, e.page_count)
FROM (
  SELECT docket_entry_id,
         count(*) AS n,
         bool_or(s3_key IS NOT NULL) AS any_pdf,
         NULLIF(sum(coalesce(page_count, 0)), 0) AS pages
  FROM registry.documents
  WHERE docket_entry_id IS NOT NULL
  GROUP BY 1
) agg
WHERE agg.docket_entry_id = e.docket_entry_id;
