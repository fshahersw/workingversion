-- ============================================================================
-- Scheduled DocketBird AutoCalendar refresh.
--
-- Posts to the app route /api/public/calendar/sync every 30 minutes with the
-- shared X-Ingest-Key header. The route pulls the firm AutoCalendar from
-- DocketBird and upserts corpus.calendar_entries; on failure it returns JSON
-- and leaves the cache untouched.
--
-- The ingest key is supplied at apply time, never committed:
--   psql "$CORPUS_DB_URL" \
--     -v ingest_key="$INGEST_API_KEY" \
--     -f supabase/corpus/calendar-sync-cron.sql
--
-- Idempotent.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- --------------------------------------------------------------- secrets ----
-- Stored in the vault so the key never appears in cron.job command text.
SELECT vault.create_secret(
  'https://project--69032d3d-8ec5-49b7-9ecb-806e580dd3cd.lovable.app/api/public/calendar/sync',
  'calendar_sync_url',
  'Endpoint for the scheduled DocketBird AutoCalendar refresh'
)
WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'calendar_sync_url');

SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'calendar_sync_url'),
  'https://project--69032d3d-8ec5-49b7-9ecb-806e580dd3cd.lovable.app/api/public/calendar/sync'
);

SELECT vault.create_secret(:'ingest_key', 'calendar_sync_key', 'X-Ingest-Key for the calendar sync route')
WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'calendar_sync_key');

SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'calendar_sync_key'),
  :'ingest_key'
);

-- -------------------------------------------------------------- trigger -----
CREATE OR REPLACE FUNCTION corpus.trigger_calendar_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = corpus, public, extensions, vault
AS $fn$
DECLARE
  target_url text;
  ingest_key text;
BEGIN
  SELECT decrypted_secret INTO target_url FROM vault.decrypted_secrets WHERE name = 'calendar_sync_url';
  SELECT decrypted_secret INTO ingest_key FROM vault.decrypted_secrets WHERE name = 'calendar_sync_key';
  IF target_url IS NULL OR ingest_key IS NULL THEN
    RAISE NOTICE 'calendar sync secrets not configured';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := target_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-ingest-key', ingest_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
END;
$fn$;

REVOKE ALL ON FUNCTION corpus.trigger_calendar_sync() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------- schedule -----
SELECT cron.unschedule('calendar-sync-30m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calendar-sync-30m');

SELECT cron.schedule('calendar-sync-30m', '*/30 * * * *', $$SELECT corpus.trigger_calendar_sync();$$);
