-- ===========================================================================
-- Drop the legacy `registry` schema (corpus v1). IRREVERSIBLE.
--
-- Order matters: PostgREST lists its exposed schemas in
-- `authenticator`'s `pgrst.db_schemas`. Removing a listed schema while it is
-- still configured wedges the schema cache (PGRST002, every request 503) and
-- the running instance will not pick up a config change while wedged.
-- So ALWAYS shrink the exposed-schema list first, confirm the API answers
-- 200, and only then drop.
--
-- Prerequisite (already applied):
--   ALTER ROLE authenticator SET pgrst.db_schemas = 'public, corpus';
--   NOTIFY pgrst, 'reload config';
--
-- Run against the corpus Postgres (CORPUS_DB_URL). Idempotent.
-- ===========================================================================
DROP SCHEMA IF EXISTS registry CASCADE;
DROP SCHEMA IF EXISTS registry_retired CASCADE;
