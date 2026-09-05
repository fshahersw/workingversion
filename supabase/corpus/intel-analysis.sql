-- ============================================================================
-- Cached AI analysis for the litigation intelligence terminal.
--
-- Additive and idempotent. Apply with:
--   psql "$CORPUS_DB_URL" -f supabase/corpus/intel-analysis.sql
-- ============================================================================

ALTER TABLE corpus.intel_items
  ADD COLUMN IF NOT EXISTS analysis_lead    text,
  ADD COLUMN IF NOT EXISTS analysis_bullets text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS analysis_impact  text;

-- Plain-language briefing for raw docket entries, keyed by entry id.
CREATE TABLE IF NOT EXISTS corpus.docket_analysis (
  docket_entry_id uuid PRIMARY KEY,
  lead            text,
  bullets         text[] NOT NULL DEFAULT '{}',
  impact          text,
  generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW public.corpus_intel_items AS
SELECT
  intel_id, canonical_url, url, category, title, summary,
  source_domain, source_name, favicon_url, image_url, image_kind, image_alt,
  signal_score, tavily_score, paywall, rights, render_mode,
  published_at, fetched_at, primary_sources, related_topics, related_sources,
  pack_ids, author, matter_slug, matter_label, run_id, created_at, updated_at,
  analysis_lead, analysis_bullets, analysis_impact
FROM corpus.intel_items;

CREATE OR REPLACE VIEW public.corpus_docket_analysis AS
SELECT docket_entry_id, lead, bullets, impact, generated_at
FROM corpus.docket_analysis;

REVOKE ALL ON public.corpus_intel_items     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.corpus_docket_analysis FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.corpus_intel_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corpus_docket_analysis TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON corpus.docket_analysis TO service_role;

-- --------------------------------------------------------------------- rpc --
CREATE OR REPLACE FUNCTION public.intel_ingest(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, corpus
AS $$
DECLARE
  v_run        uuid;
  v_generated  timestamptz := coalesce((payload->>'generated_at')::timestamptz, now());
  v_items      jsonb := coalesce(payload->'items', '[]'::jsonb);
  v_before     integer;
  v_after      integer;
  v_touched    integer;
  v_pruned     integer;
  v_retain     integer := coalesce((payload->>'retain_days')::integer, 90);
BEGIN
  SELECT count(*) INTO v_before FROM corpus.intel_items;

  INSERT INTO corpus.intel_runs (generated_at, schema_version, item_count, stats, errors)
  VALUES (
    v_generated,
    payload->>'schema_version',
    jsonb_array_length(v_items),
    coalesce(payload->'stats', '{}'::jsonb),
    coalesce(payload->'errors', '{}'::jsonb)
  )
  RETURNING run_id INTO v_run;

  WITH src AS (
    SELECT * FROM jsonb_to_recordset(v_items) AS x(
      intel_id text, canonical_url text, url text, category text, title text,
      summary text, source_domain text, source_name text, favicon_url text,
      image_url text, image_kind text, image_alt text,
      signal_score double precision, tavily_score double precision,
      paywall text, rights text, render_mode text,
      published_at timestamptz, fetched_at timestamptz,
      primary_sources jsonb, related_topics text[], related_sources jsonb,
      pack_ids text[], author text, matter_slug text, matter_label text,
      analysis_lead text, analysis_bullets text[], analysis_impact text
    )
  ), ranked AS (
    SELECT DISTINCT ON (canonical_url) * FROM src
    ORDER BY canonical_url, signal_score DESC NULLS LAST
  ), ins AS (
    INSERT INTO corpus.intel_items AS t (
      intel_id, canonical_url, url, category, title, summary,
      source_domain, source_name, favicon_url, image_url, image_kind, image_alt,
      signal_score, tavily_score, paywall, rights, render_mode,
      published_at, fetched_at, primary_sources, related_topics, related_sources,
      pack_ids, author, matter_slug, matter_label, run_id,
      analysis_lead, analysis_bullets, analysis_impact
    )
    SELECT
      intel_id, canonical_url, url, coalesce(category, 'News'), title, summary,
      source_domain, source_name, favicon_url, image_url, image_kind, image_alt,
      coalesce(signal_score, 0), tavily_score, paywall, rights, render_mode,
      published_at, coalesce(fetched_at, now()),
      coalesce(primary_sources, '[]'::jsonb), coalesce(related_topics, '{}'),
      coalesce(related_sources, '[]'::jsonb), coalesce(pack_ids, '{}'),
      author, matter_slug, matter_label, v_run,
      analysis_lead, coalesce(analysis_bullets, '{}'), analysis_impact
    FROM ranked
    ON CONFLICT (canonical_url) DO UPDATE SET
      url = excluded.url, category = excluded.category, title = excluded.title,
      summary = excluded.summary, source_domain = excluded.source_domain,
      source_name = excluded.source_name, favicon_url = excluded.favicon_url,
      image_url = excluded.image_url, image_kind = excluded.image_kind,
      image_alt = excluded.image_alt, signal_score = excluded.signal_score,
      tavily_score = excluded.tavily_score, paywall = excluded.paywall,
      rights = excluded.rights, render_mode = excluded.render_mode,
      published_at = excluded.published_at, fetched_at = excluded.fetched_at,
      primary_sources = excluded.primary_sources,
      related_topics = excluded.related_topics,
      related_sources = excluded.related_sources,
      pack_ids = excluded.pack_ids, author = excluded.author,
      matter_slug = excluded.matter_slug, matter_label = excluded.matter_label,
      analysis_lead = coalesce(excluded.analysis_lead, t.analysis_lead),
      analysis_bullets = CASE
        WHEN coalesce(array_length(excluded.analysis_bullets, 1), 0) > 0
          THEN excluded.analysis_bullets ELSE t.analysis_bullets END,
      analysis_impact = coalesce(excluded.analysis_impact, t.analysis_impact),
      run_id = v_run, updated_at = now()
    WHERE excluded.fetched_at >= t.fetched_at
    RETURNING 1
  )
  SELECT count(*) INTO v_touched FROM ins;

  DELETE FROM corpus.intel_items
  WHERE coalesce(published_at, fetched_at) < now() - make_interval(days => v_retain);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  SELECT count(*) INTO v_after FROM corpus.intel_items;

  UPDATE corpus.intel_runs
     SET inserted = greatest(v_after - v_before + v_pruned, 0),
         updated  = greatest(v_touched - greatest(v_after - v_before + v_pruned, 0), 0),
         pruned   = v_pruned
   WHERE run_id = v_run;

  RETURN jsonb_build_object(
    'run_id', v_run,
    'received', jsonb_array_length(v_items),
    'upserted', v_touched,
    'pruned', v_pruned,
    'total', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.intel_ingest(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_ingest(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
