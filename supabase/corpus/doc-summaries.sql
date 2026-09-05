-- ============================================================================
-- Document summarizer storage.
--
-- Holds one row per completed summarization run: the finished memo, the
-- per-section digests that produced it, and a pointer to the uploaded source
-- object so the original can be reopened later.
--
-- Idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/doc-summaries.sql
--
-- Access model matches the rest of the corpus: the bridge view is readable and
-- writable by service_role only; the app reaches it through server functions
-- using CORPUS_SERVICE_KEY.
-- ============================================================================

CREATE TABLE IF NOT EXISTS corpus.doc_summaries (
  summary_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id       uuid REFERENCES corpus.matters(matter_id) ON DELETE SET NULL,
  matter_slug     text,
  matter_label    text,
  title           text NOT NULL,
  source_kind     text,                 -- pdf | docx | txt | mixed
  file_names      jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_count      integer NOT NULL DEFAULT 0,
  char_count      integer NOT NULL DEFAULT 0,
  section_count   integer NOT NULL DEFAULT 0,
  model           text,
  summary_md      text NOT NULL DEFAULT '',
  section_digests jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_keys     jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_email     text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_summaries_created_idx
  ON corpus.doc_summaries (created_at DESC);
CREATE INDEX IF NOT EXISTS doc_summaries_owner_idx
  ON corpus.doc_summaries (owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS doc_summaries_matter_idx
  ON corpus.doc_summaries (matter_id);

DROP TRIGGER IF EXISTS doc_summaries_touch ON corpus.doc_summaries;

CREATE OR REPLACE FUNCTION corpus.touch_doc_summary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = corpus, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER doc_summaries_touch
  BEFORE UPDATE ON corpus.doc_summaries
  FOR EACH ROW EXECUTE FUNCTION corpus.touch_doc_summary();

-- ------------------------------------------------------------ bridge view --
CREATE OR REPLACE VIEW public.corpus_doc_summaries AS
SELECT
  summary_id,
  matter_id,
  matter_slug,
  matter_label,
  title,
  source_kind,
  file_names,
  page_count,
  char_count,
  section_count,
  model,
  summary_md,
  section_digests,
  source_keys,
  owner_email,
  duration_ms,
  created_at,
  updated_at
FROM corpus.doc_summaries;

REVOKE ALL ON public.corpus_doc_summaries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corpus_doc_summaries TO service_role;
