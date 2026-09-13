-- ============================================================================
-- KB 0003 — court reference library (reference.* schema) + docket judge columns.
--
-- Firm-global reference data used by the matters workspace: per-court identity
-- (name, level, jurisdiction, website, published mark), the judges the firm has
-- official portraits for, and the court's rules / standing orders / forms held
-- in the document library. Unlike kb.* this is NOT tenant data: it is read by
-- every user with NO row-level security and only SELECT granted to kb_app. The
-- rows and S3 assets (logos, portraits, documents) are populated out-of-band by
-- the reference-library tooling; this migration only owns the shape.
--
-- Idempotent: safe to re-run. Reached directly via the RDS Data API (no
-- PostgREST constructs). Apply against the same Aurora cluster as kb.* / corpus.*.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS reference;

-- Least-privilege application role (created in 0001; guarded here so this file
-- is self-contained and re-runnable in isolation).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_app') THEN
    CREATE ROLE kb_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA reference TO kb_app;

-- --- courts ------------------------------------------------------------------
-- One row per reference-library court. court_key is the stable library id, e.g.
-- "FD:njd" (federal district), "FS:jpml" (the Panel), "ST:ca_state" (statewide
-- state collection), "LC:ca_los_angeles" (a selected local trial court). See
-- courtReferenceKeys() in src/lib/courts.ts for the docket-court -> key mapping.

CREATE TABLE IF NOT EXISTS reference.courts (
  court_key        text PRIMARY KEY,
  court_id         text,                             -- DocketBird / CourtListener court id when 1:1
  name             text NOT NULL,
  level            text NOT NULL,
  jurisdiction     text NOT NULL,
  website          text,
  forms_pages      jsonb NOT NULL DEFAULT '[]'::jsonb, -- string[] of forms/rules landing pages
  logo_key         text,                             -- S3 key of the court mark, presigned at read time
  logo_kind        text,
  logo_background  text,                             -- "light" | "dark" (background the mark was published on)
  compact_key      text,
  fallback_text    text NOT NULL,                    -- initials shown when no mark is held
  reuse_note       text,
  document_count   integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courts_court_id_idx ON reference.courts (court_id);

-- --- judges ------------------------------------------------------------------
-- Judges the library holds an official portrait or attribution for, per court.
-- Portraits surface ONLY for a judge a docket itself names (assigned/referred);
-- matching is surname + first name on the same court (see judgeMatches()).

CREATE TABLE IF NOT EXISTS reference.judges (
  judge_key     text PRIMARY KEY,
  court_key     text NOT NULL,
  name          text NOT NULL,
  surname       text NOT NULL,
  portrait_key  text,                                -- S3 key of the portrait, presigned at read time
  source_page   text,
  reuse_note    text
);

CREATE INDEX IF NOT EXISTS judges_court_idx ON reference.judges (court_key, surname);

-- --- court documents ---------------------------------------------------------
-- Court rules, standing orders, forms and templates from the firm's document
-- library. court_keys is the overlap set a document applies to (a local rule
-- can cover both an "LC:" court and its "ST:" statewide collection); queried
-- with the && array-overlap operator, hence the GIN index.

CREATE TABLE IF NOT EXISTS reference.court_documents (
  sha256            text PRIMARY KEY,
  court_key         text,                            -- primary court, when a document has one
  court_keys        text[] NOT NULL DEFAULT '{}'::text[],
  jurisdiction      text,
  title             text NOT NULL,
  kind              text NOT NULL,                   -- standing_order|local_rule|form|instruction|order|other
  format            text NOT NULL,                   -- pdf|docx|doc|rtf
  bytes             bigint,
  page_count        integer,
  s3_key            text NOT NULL,                   -- original document in the library bucket
  source_url        text,
  source_date       text,
  source_date_kind  text,
  review_status     text,
  fillable          boolean,
  judge_name        text,                            -- judge named in a standing order's title, when any
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS court_documents_court_kind_idx
  ON reference.court_documents (court_key, kind);
CREATE INDEX IF NOT EXISTS court_documents_keys_idx
  ON reference.court_documents USING gin (court_keys);

-- Read-only for the application role; reference rows are curated out-of-band.
GRANT SELECT ON reference.courts, reference.judges, reference.court_documents TO kb_app;

-- --- docket judge columns ----------------------------------------------------
-- The court layer reads the assigned / referred judge recorded on the lead
-- docket (from CourtListener) to decide which portraits to show. The corpus.*
-- schema is otherwise managed out-of-band; only these two feature-owned columns
-- are declared here.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'corpus' AND table_name = 'dockets'
  ) THEN
    ALTER TABLE corpus.dockets ADD COLUMN IF NOT EXISTS assigned_judge text;
    ALTER TABLE corpus.dockets ADD COLUMN IF NOT EXISTS referred_judge text;
  END IF;
END $$;
