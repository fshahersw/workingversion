-- ============================================================================
-- DocketBird AutoCalendar cache. The UI reads this table; a worker upserts
-- from GET /calendar_entries a few times a day. Every firm-followed case
-- is stored here. corpus.matters is linked when we already have it — followed
-- cases are not ingested into the corpus just to appear on the calendar.
--
-- Idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/calendar-entries.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS corpus.calendar_entries (
  entry_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint         text NOT NULL UNIQUE,
  matter_id           uuid REFERENCES corpus.matters(matter_id) ON DELETE CASCADE,
  matter_slug         text NOT NULL,
  matter_name         text NOT NULL,
  case_id             text NOT NULL,
  case_name           text NOT NULL,
  event_date          date NOT NULL,
  event_time          text,
  title               text NOT NULL,
  source_document_id  text,
  in_corpus           boolean NOT NULL DEFAULT false,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE corpus.calendar_entries ADD COLUMN IF NOT EXISTS in_corpus boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS calendar_entries_date_idx
  ON corpus.calendar_entries (event_date, event_time);
CREATE INDEX IF NOT EXISTS calendar_entries_matter_idx
  ON corpus.calendar_entries (matter_slug, event_date);

CREATE TABLE IF NOT EXISTS corpus.calendar_sync_runs (
  run_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at      timestamptz NOT NULL DEFAULT now(),
  window_start   date,
  window_end     date,
  source_updated text,
  matched        integer NOT NULL DEFAULT 0,
  upserted       integer NOT NULL DEFAULT 0,
  pruned         integer NOT NULL DEFAULT 0,
  skipped        integer NOT NULL DEFAULT 0,
  error          text
);

CREATE INDEX IF NOT EXISTS calendar_sync_runs_synced_idx
  ON corpus.calendar_sync_runs (synced_at DESC);

DROP TRIGGER IF EXISTS calendar_entries_updated_at ON corpus.calendar_entries;
CREATE TRIGGER calendar_entries_updated_at
  BEFORE UPDATE ON corpus.calendar_entries
  FOR EACH ROW EXECUTE FUNCTION corpus.set_updated_at();

ALTER TABLE corpus.calendar_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus.calendar_sync_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON corpus.calendar_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON corpus.calendar_sync_runs TO service_role;

DROP VIEW IF EXISTS public.corpus_calendar_entries;
CREATE OR REPLACE VIEW public.corpus_calendar_entries AS
SELECT
  entry_id, fingerprint, matter_id, matter_slug, matter_name,
  case_id, case_name, event_date, event_time, title, source_document_id,
  in_corpus, first_seen_at, last_seen_at, created_at, updated_at
FROM corpus.calendar_entries;

CREATE OR REPLACE VIEW public.corpus_calendar_sync_runs AS
SELECT run_id, synced_at, window_start, window_end, source_updated,
       matched, upserted, pruned, skipped, error
FROM corpus.calendar_sync_runs;

REVOKE ALL ON public.corpus_calendar_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.corpus_calendar_sync_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.corpus_calendar_entries TO service_role;
GRANT SELECT ON public.corpus_calendar_sync_runs TO service_role;

-- Atomic replace of the upcoming window. Past dates are left in place so the
-- month view keeps history as days roll by.
CREATE OR REPLACE FUNCTION public.corpus_calendar_sync(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = corpus, public
AS $$
DECLARE
  rec jsonb;
  fps text[] := ARRAY[]::text[];
  ws date;
  we date;
  n_upsert int := 0;
  n_prune int := 0;
  n_in int := 0;
BEGIN
  ws := NULLIF(payload->>'window_start', '')::date;
  we := NULLIF(payload->>'window_end', '')::date;
  n_in := jsonb_array_length(COALESCE(payload->'entries', '[]'::jsonb));

  IF n_in > 0 THEN
    fps := ARRAY(
      SELECT e->>'fingerprint' FROM jsonb_array_elements(payload->'entries') e
    );

    INSERT INTO corpus.calendar_entries (
      fingerprint, matter_id, matter_slug, matter_name,
      case_id, case_name, event_date, event_time, title, source_document_id,
      in_corpus, last_seen_at
    )
    SELECT
      d.e->>'fingerprint',
      NULLIF(d.e->>'matter_id', '')::uuid,
      d.e->>'matter_slug',
      d.e->>'matter_name',
      d.e->>'case_id',
      d.e->>'case_name',
      (d.e->>'event_date')::date,
      NULLIF(d.e->>'event_time', ''),
      d.e->>'title',
      NULLIF(d.e->>'source_document_id', ''),
      COALESCE((d.e->>'in_corpus')::boolean, false),
      now()
    FROM (
      SELECT DISTINCT ON (e->>'fingerprint') e
      FROM jsonb_array_elements(payload->'entries') e
      ORDER BY e->>'fingerprint'
    ) d
    ON CONFLICT (fingerprint) DO UPDATE SET
      matter_id = EXCLUDED.matter_id,
      matter_slug = EXCLUDED.matter_slug,
      matter_name = EXCLUDED.matter_name,
      case_name = EXCLUDED.case_name,
      event_time = EXCLUDED.event_time,
      title = EXCLUDED.title,
      source_document_id = EXCLUDED.source_document_id,
      in_corpus = EXCLUDED.in_corpus,
      last_seen_at = now();

    GET DIAGNOSTICS n_upsert = ROW_COUNT;
  END IF;

  IF n_in > 0 AND ws IS NOT NULL AND we IS NOT NULL THEN
    DELETE FROM corpus.calendar_entries
    WHERE event_date BETWEEN ws AND we
      AND NOT (fingerprint = ANY (fps));
    GET DIAGNOSTICS n_prune = ROW_COUNT;
  END IF;

  INSERT INTO corpus.calendar_sync_runs (
    window_start, window_end, source_updated, matched, upserted, pruned, skipped, error
  ) VALUES (
    ws, we,
    NULLIF(payload->>'source_updated', ''),
    n_in, n_upsert, n_prune,
    COALESCE((payload->>'skipped')::int, 0),
    NULLIF(payload->>'error', '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'matched', n_in,
    'upserted', n_upsert,
    'pruned', n_prune
  );
END;
$$;

REVOKE ALL ON FUNCTION public.corpus_calendar_sync(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_calendar_sync(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
