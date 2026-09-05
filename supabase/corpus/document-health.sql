-- ============================================================================
-- Corpus v2 health views.
--
-- Read-only defect flags and rollups over the `corpus` schema. Replaces the
-- v1 registry-era version of this file (that schema no longer exists).
--
-- Idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/document-health.sql
--
-- Notes on what counts as a defect in v2:
--   * PACER-link-only and text-only documents are NOT defects — they are
--     expected availability states. They are counted separately so a matter's
--     paid-gap size is visible.
--   * Display ordering (display_number / display_label_pretty / sort_seq) is
--     what the UI shows; synthetic JPML / blank entry numbers are internal.
-- ============================================================================

DROP VIEW IF EXISTS corpus.v_matter_health;
DROP VIEW IF EXISTS corpus.v_matter_slot_health;
DROP VIEW IF EXISTS corpus.v_document_slots;
DROP VIEW IF EXISTS corpus.v_document_health;

-- --- per-document defect flags ----------------------------------------------

CREATE VIEW corpus.v_document_health AS
SELECT
  d.document_id,
  d.matter_id,
  m.slug,
  m.docket_number,
  m.case_name                                    AS matter_title,
  d.docket_entry_id,
  d.docket_source,
  d.entry_number,
  d.display_number,
  d.display_label_pretty,
  d.attachment_number,
  d.title,
  d.doc_type,
  d.availability_status,
  d.text_status,
  d.s3_key,
  coalesce(ch.chunks, 0)                         AS chunks,
  coalesce(ch.unembedded, 0)                     AS unembedded_chunks,

  -- availability (states, not defects)
  (d.s3_key IS NOT NULL)                                          AS has_pdf,
  (d.s3_key IS NULL AND d.availability_status = 'pacer_link')     AS is_pacer_gap,
  (d.s3_key IS NULL AND d.availability_status = 'text_only')      AS is_text_only,

  -- defect flags
  (
    d.s3_key IS NULL
    AND coalesce(d.availability_status, '') NOT IN ('pacer_link', 'text_only')
    AND d.recap_url IS NULL
    AND d.archive_url IS NULL
    AND d.pacer_url IS NULL
    AND d.courtlistener_url IS NULL
  )                                                               AS f_unfetchable,
  (d.title IS NULL OR btrim(d.title) = '')                        AS f_no_title,
  (
    d.title IS NOT NULL AND btrim(d.title) <> ''
    AND (
      length(btrim(d.title)) < 6
      OR lower(btrim(d.title)) IN (
        'letter','order','brief','exhibit','notice','document','attachment',
        'declaration','motion','other','n/a','unknown','main document'
      )
    )
  )                                                               AS f_generic_title,
  (
    d.attachment_number > 0
    AND e.description IS NOT NULL
    AND lower(btrim(coalesce(d.title, ''))) = lower(btrim(e.description))
  )                                                               AS f_title_equals_entry,
  (d.docket_entry_id IS NULL)                                     AS f_orphan_entry,
  (d.doc_type IS NULL OR btrim(d.doc_type) = '')                  AS f_no_doc_type,
  (d.s3_key IS NOT NULL AND d.page_count IS NULL)                 AS f_no_page_count,
  (d.s3_key IS NOT NULL AND d.byte_count IS NULL)                 AS f_no_byte_count,
  (d.s3_key IS NOT NULL AND d.sha256 IS NULL)                     AS f_no_sha256,
  (
    d.expected_sha256 IS NOT NULL AND d.sha256 IS NOT NULL
    AND d.sha256 <> d.expected_sha256
  )                                                               AS f_hash_mismatch,
  (dupe.dupe_count > 1)                                           AS f_duplicate_s3_key,
  (d.s3_key IS NOT NULL AND d.text_status <> 'extracted')         AS f_not_extracted,
  (d.text_status = 'extracted' AND coalesce(ch.chunks, 0) = 0)    AS f_no_chunks,
  (coalesce(ch.unembedded, 0) > 0)                                AS f_unembedded,
  (d.display_label_pretty IS NULL OR d.sort_seq IS NULL)          AS f_no_display_order
FROM corpus.documents d
JOIN corpus.matters m USING (matter_id)
LEFT JOIN corpus.docket_entries e ON e.docket_entry_id = d.docket_entry_id
LEFT JOIN LATERAL (
  SELECT
    count(*)                                     AS chunks,
    count(*) FILTER (WHERE c.embedding IS NULL)  AS unembedded
  FROM corpus.doc_chunks c
  WHERE c.document_id = d.document_id
) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS dupe_count
  FROM corpus.documents d2
  WHERE d2.s3_key IS NOT NULL AND d2.s3_key = d.s3_key
) dupe ON TRUE;

-- --- per-matter rollup -------------------------------------------------------

CREATE VIEW corpus.v_matter_health AS
WITH doc AS (
  SELECT
    matter_id,
    slug,
    docket_number,
    matter_title,
    count(*)                                            AS documents,
    count(*) FILTER (WHERE has_pdf)                     AS documents_with_pdf,
    count(*) FILTER (WHERE is_pacer_gap)                AS pacer_gap,
    count(*) FILTER (WHERE is_text_only)                AS text_only,
    count(*) FILTER (WHERE text_status = 'extracted')   AS extracted,
    count(*) FILTER (WHERE has_pdf OR is_text_only)     AS extractable,
    sum(chunks)                                         AS chunks,
    sum(unembedded_chunks)                              AS unembedded_chunks,
    count(*) FILTER (WHERE f_unfetchable)               AS unfetchable,
    count(*) FILTER (WHERE f_no_title)                  AS no_title,
    count(*) FILTER (WHERE f_generic_title)             AS generic_title,
    count(*) FILTER (WHERE f_title_equals_entry)        AS title_equals_entry,
    count(*) FILTER (WHERE f_orphan_entry)              AS orphan_entry,
    count(*) FILTER (WHERE f_no_doc_type)               AS no_doc_type,
    count(*) FILTER (WHERE f_no_page_count)             AS no_page_count,
    count(*) FILTER (WHERE f_no_byte_count)             AS no_byte_count,
    count(*) FILTER (WHERE f_no_sha256)                 AS no_sha256,
    count(*) FILTER (WHERE f_hash_mismatch)             AS hash_mismatch,
    count(*) FILTER (WHERE f_duplicate_s3_key)          AS duplicate_s3_key,
    count(*) FILTER (WHERE f_not_extracted)             AS not_extracted,
    count(*) FILTER (WHERE f_no_chunks)                 AS no_chunks,
    count(*) FILTER (WHERE f_unembedded)                AS unembedded_docs,
    count(*) FILTER (WHERE f_no_display_order)          AS no_display_order
  FROM corpus.v_document_health
  GROUP BY 1, 2, 3, 4
), ent AS (
  SELECT
    matter_id,
    count(*)                                                               AS entries,
    count(*) FILTER (WHERE description IS NULL OR btrim(description) = '') AS entries_no_description,
    count(*) FILTER (WHERE date_filed IS NULL)                             AS entries_no_date,
    count(*) FILTER (WHERE NOT has_pdf)                                    AS entries_no_pdf,
    max(display_number) FILTER (WHERE docket_source = 'main')              AS max_main_entry,
    count(*) FILTER (WHERE docket_source = 'main')                         AS main_entries
  FROM corpus.docket_entries
  GROUP BY 1
)
SELECT
  m.matter_id,
  m.slug,
  m.docket_number,
  m.case_name                                  AS matter_title,
  m.pipeline_stage,
  m.verified_at,
  coalesce(ent.entries, 0)                     AS entries,
  coalesce(ent.entries_no_description, 0)      AS entries_no_description,
  coalesce(ent.entries_no_date, 0)             AS entries_no_date,
  coalesce(ent.entries_no_pdf, 0)              AS entries_no_pdf,
  GREATEST(coalesce(ent.max_main_entry, 0) - coalesce(ent.main_entries, 0), 0) AS main_entry_gap,
  coalesce(doc.documents, 0)                   AS documents,
  coalesce(doc.documents_with_pdf, 0)          AS documents_with_pdf,
  round(100.0 * coalesce(doc.documents_with_pdf, 0)
        / NULLIF(doc.documents, 0), 1)         AS pdf_coverage_pct,
  round(100.0 * coalesce(doc.extracted, 0)
        / NULLIF(doc.extractable, 0), 1)       AS extract_coverage_pct,
  round(100.0 * (coalesce(doc.chunks, 0) - coalesce(doc.unembedded_chunks, 0))
        / NULLIF(doc.chunks, 0), 1)            AS embed_coverage_pct,
  coalesce(doc.chunks, 0)                      AS chunks,
  coalesce(doc.unembedded_chunks, 0)           AS unembedded_chunks,
  coalesce(doc.pacer_gap, 0)                   AS pacer_gap,
  coalesce(doc.text_only, 0)                   AS text_only,
  coalesce(doc.unfetchable, 0)                 AS unfetchable,
  coalesce(doc.no_title, 0)                    AS no_title,
  coalesce(doc.generic_title, 0)               AS generic_title,
  coalesce(doc.title_equals_entry, 0)          AS title_equals_entry,
  coalesce(doc.orphan_entry, 0)                AS orphan_entry,
  coalesce(doc.no_doc_type, 0)                 AS no_doc_type,
  coalesce(doc.no_page_count, 0)               AS no_page_count,
  coalesce(doc.no_byte_count, 0)               AS no_byte_count,
  coalesce(doc.no_sha256, 0)                   AS no_sha256,
  coalesce(doc.hash_mismatch, 0)               AS hash_mismatch,
  coalesce(doc.duplicate_s3_key, 0)            AS duplicate_s3_key,
  coalesce(doc.not_extracted, 0)               AS not_extracted,
  coalesce(doc.no_chunks, 0)                   AS no_chunks,
  coalesce(doc.unembedded_docs, 0)             AS unembedded_docs,
  coalesce(doc.no_display_order, 0)            AS no_display_order,
  round(
    100.0 * (
      1 - (
          coalesce(doc.unfetchable, 0) + coalesce(doc.no_title, 0)
        + coalesce(doc.generic_title, 0) + coalesce(doc.title_equals_entry, 0)
        + coalesce(doc.orphan_entry, 0) + coalesce(doc.no_doc_type, 0)
        + coalesce(doc.no_page_count, 0) + coalesce(doc.no_byte_count, 0)
        + coalesce(doc.no_sha256, 0) + coalesce(doc.hash_mismatch, 0)
        + coalesce(doc.duplicate_s3_key, 0) + coalesce(doc.not_extracted, 0)
        + coalesce(doc.no_chunks, 0) + coalesce(doc.unembedded_docs, 0)
        + coalesce(doc.no_display_order, 0)
      )::numeric / NULLIF(coalesce(doc.documents, 0) * 15, 0)
    ), 1
  )                                            AS health_score
FROM corpus.matters m
LEFT JOIN doc ON doc.matter_id = m.matter_id
LEFT JOIN ent ON ent.matter_id = m.matter_id;

-- --- slot-level coverage -----------------------------------------------------

CREATE VIEW corpus.v_document_slots AS
SELECT
  d.matter_id,
  m.slug,
  m.docket_number,
  d.docket_source,
  coalesce(d.display_label_pretty, d.entry_label, d.entry_number::text) AS entry_label,
  d.display_number,
  d.attachment_number,
  count(*)                                                     AS row_count,
  bool_or(d.s3_key IS NOT NULL)                                AS has_pdf,
  bool_or(
    d.recap_url IS NOT NULL OR d.archive_url IS NOT NULL
    OR d.pacer_url IS NOT NULL OR d.courtlistener_url IS NOT NULL
  )                                                            AS has_fetch_url,
  bool_or(d.availability_status = 'pacer_link')                AS is_pacer_gap,
  bool_or(d.availability_status = 'text_only')                 AS is_text_only,
  max(length(coalesce(d.title, '')))                           AS best_title_len,
  (array_agg(d.title ORDER BY length(coalesce(d.title, '')) DESC))[1] AS best_title
FROM corpus.documents d
JOIN corpus.matters m USING (matter_id)
GROUP BY 1, 2, 3, 4, 5, 6, 7;

CREATE VIEW corpus.v_matter_slot_health AS
SELECT
  matter_id,
  slug,
  docket_number,
  docket_source,
  count(*)                                                                   AS slots,
  count(*) FILTER (WHERE has_pdf)                                            AS slots_with_pdf,
  count(*) FILTER (WHERE NOT has_pdf AND is_pacer_gap)                       AS slots_pacer_gap,
  count(*) FILTER (WHERE NOT has_pdf AND is_text_only)                       AS slots_text_only,
  count(*) FILTER (WHERE NOT has_pdf AND has_fetch_url
                     AND NOT is_pacer_gap AND NOT is_text_only)              AS slots_fetchable,
  count(*) FILTER (WHERE NOT has_pdf AND NOT has_fetch_url
                     AND NOT is_pacer_gap AND NOT is_text_only)              AS slots_unreachable,
  sum(row_count) - count(*)                                                  AS duplicate_rows,
  count(*) FILTER (WHERE best_title_len < 6)                                 AS slots_weak_title,
  round(100.0 * count(*) FILTER (WHERE has_pdf) / NULLIF(count(*), 0), 1)    AS pdf_coverage_pct
FROM corpus.v_document_slots
GROUP BY 1, 2, 3, 4;

GRANT SELECT ON corpus.v_document_health, corpus.v_matter_health,
                corpus.v_document_slots, corpus.v_matter_slot_health
  TO service_role;
