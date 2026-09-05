CREATE OR REPLACE FUNCTION public.trigger_intel_run()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  target_url text;
  ingest_key text;
BEGIN
  SELECT decrypted_secret INTO target_url FROM vault.decrypted_secrets WHERE name = 'intel_run_url';
  SELECT decrypted_secret INTO ingest_key FROM vault.decrypted_secrets WHERE name = 'intel_ingest_key';
  IF target_url IS NULL OR ingest_key IS NULL THEN
    RAISE NOTICE 'intel run secrets not configured';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := target_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-ingest-key', ingest_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_intel_run() FROM PUBLIC, anon, authenticated;