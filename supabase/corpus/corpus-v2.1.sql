-- ============================================================================
-- Corpus v2.1: canonical-ingest columns.
-- Driven by the full-fidelity docket exports (33-column docket CSV with
-- precomputed hashes + source URLs, parties/attorneys CSV, case metadata JSON).
-- Idempotent. Run against the corpus Postgres (CORPUS_DB_URL).
-- ============================================================================

-- documents: provenance URLs, availability triage, hash verification ---------

ALTER TABLE corpus.documents
  ADD COLUMN IF NOT EXISTS record_id          text,        -- export row id ("0001")
  ADD COLUMN IF NOT EXISTS availability_status text,       -- free_recap / pacer_link / text_only
  ADD COLUMN IF NOT EXISTS recap_url          text,
  ADD COLUMN IF NOT EXISTS archive_url        text,
  ADD COLUMN IF NOT EXISTS pacer_url          text,
  ADD COLUMN IF NOT EXISTS pacer_price_usd    numeric(6,2),
  ADD COLUMN IF NOT EXISTS expected_sha256    text,        -- hash from the docket export
  ADD COLUMN IF NOT EXISTS sha1               text,
  ADD COLUMN IF NOT EXISTS md5                text,
  ADD COLUMN IF NOT EXISTS hash_verified      boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS v2_documents_availability_idx
  ON corpus.documents (matter_id, availability_status);

-- counsel: leadership flags + contact detail ----------------------------------

ALTER TABLE corpus.counsel
  ADD COLUMN IF NOT EXISTS is_lead      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone        text,
  ADD COLUMN IF NOT EXISTS fax          text,
  ADD COLUMN IF NOT EXISTS address      text,
  ADD COLUMN IF NOT EXISTS designations text;

-- matters: bibliographic fields from the case metadata export -----------------

ALTER TABLE corpus.matters
  ADD COLUMN IF NOT EXISTS caption           text,         -- "SHOSHI GOLDFUS v. APPLE, INC."
  ADD COLUMN IF NOT EXISTS magistrate_judge  text,
  ADD COLUMN IF NOT EXISTS cause             text,
  ADD COLUMN IF NOT EXISTS nature_of_suit    text,
  ADD COLUMN IF NOT EXISTS jury_demand       text,
  ADD COLUMN IF NOT EXISTS jurisdiction_type text,
  ADD COLUMN IF NOT EXISTS pacer_case_id     bigint,
  ADD COLUMN IF NOT EXISTS pacer_url         text;
