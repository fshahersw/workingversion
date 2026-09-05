-- ===========================================================================
-- Retire the legacy `registry` schema (corpus v1).
--
-- Step 1 (this file): rename it out of the API surface. Reversible — rename
-- back with `ALTER SCHEMA registry_retired RENAME TO registry;`.
-- Step 2: supabase/corpus/drop-registry.sql performs the irreversible drop.
--
-- Run against the corpus Postgres (CORPUS_DB_URL). Idempotent.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'registry') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA registry FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE USAGE ON SCHEMA registry FROM anon, authenticated, service_role';
    EXECUTE 'ALTER SCHEMA registry RENAME TO registry_retired';
    RAISE NOTICE 'registry -> registry_retired';
  ELSE
    RAISE NOTICE 'registry schema already retired';
  END IF;
END $$;
