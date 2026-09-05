-- Cron-only token, generated and kept inside the database vault.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'intel_cron_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'intel_cron_token', 'Token for the scheduled intel refresh');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'intel_run_url') THEN
    PERFORM vault.create_secret('https://project--69032d3d-8ec5-49b7-9ecb-806e580dd3cd.lovable.app/api/public/intel/run', 'intel_run_url', 'Endpoint for the scheduled intel refresh');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.verify_intel_cron_token(token text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'intel_cron_token' AND decrypted_secret = token
  );
$$;

REVOKE ALL ON FUNCTION public.verify_intel_cron_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_intel_cron_token(text) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_intel_run()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  target_url text;
  cron_token text;
BEGIN
  SELECT decrypted_secret INTO target_url FROM vault.decrypted_secrets WHERE name = 'intel_run_url';
  SELECT decrypted_secret INTO cron_token FROM vault.decrypted_secrets WHERE name = 'intel_cron_token';
  IF target_url IS NULL OR cron_token IS NULL THEN
    RAISE NOTICE 'intel run secrets not configured';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := target_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-token', cron_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_intel_run() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('intel-refresh-4h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-refresh-4h');
SELECT cron.schedule('intel-refresh-4h', '17 */4 * * *', $$SELECT public.trigger_intel_run();$$);