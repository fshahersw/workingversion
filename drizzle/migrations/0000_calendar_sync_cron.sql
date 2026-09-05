-- Scheduled DocketBird AutoCalendar refresh.
-- A pg_cron job posts to /api/public/calendar/sync every 30 minutes with the
-- shared X-Ingest-Key header. The app route pulls the firm AutoCalendar from
-- DocketBird and upserts the corpus calendar cache; on failure it returns JSON
-- and leaves the cache untouched.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Private config store for the scheduled job. Not exposed to the Data API:
-- RLS on with no policies, and no grants to anon/authenticated.
CREATE TABLE IF NOT EXISTS public.cron_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cron_config FROM PUBLIC;
GRANT ALL ON public.cron_config TO service_role;
-- Temporary: lets the setup tooling write the ingest key without it ever
-- appearing in migration text. Revoked in the follow-up migration.
GRANT SELECT, INSERT, UPDATE ON public.cron_config TO sandbox_exec;

INSERT INTO public.cron_config (key, value)
VALUES ('calendar_sync_url', 'https://project--69032d3d-8ec5-49b7-9ecb-806e580dd3cd.lovable.app/api/public/calendar/sync')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

CREATE OR REPLACE FUNCTION public.trigger_calendar_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  target_url text;
  ingest_key text;
BEGIN
  SELECT value INTO target_url FROM public.cron_config WHERE key = 'calendar_sync_url';
  SELECT value INTO ingest_key FROM public.cron_config WHERE key = 'calendar_sync_key';
  IF target_url IS NULL OR ingest_key IS NULL THEN
    RAISE NOTICE 'calendar sync config not set';
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

REVOKE ALL ON FUNCTION public.trigger_calendar_sync() FROM PUBLIC;

SELECT cron.unschedule('calendar-sync-30m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calendar-sync-30m');

SELECT cron.schedule('calendar-sync-30m', '*/30 * * * *', $$SELECT public.trigger_calendar_sync();$$);
