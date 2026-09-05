# Fix the corpus API outage (PGRST002 loop)

## What the logs show

The corpus database itself is healthy — the API layer connects fine ("Successfully connected to PostgreSQL 17.6", "Connection Pool initialized", "Config reloaded"). Every request then fails with `503 / PGRST002 – Could not query the database for the schema cache. Retrying.` in a tight loop (47 occurrences in this window).

The one non-repeating line names the cause:

```text
db-extra-search-path=public,extensions,storage,auth,graphql,graphql_public,
supabase_migrations,staging,pgbouncer,realtime,registry,corpus
{"code":"3F000","message":"schema \"registry\" does not exist"}
```

The API's extra search path still lists the `registry` schema that was dropped. Building the schema cache sets that search path, hits `3F000`, aborts, and the API answers 503 to everything. This is a stale configuration leftover, not data loss — nothing in `corpus` is damaged.

## The fix

1. Remove `registry` from the API role's extra search path, leaving `public, extensions, storage, auth, graphql, graphql_public, supabase_migrations, staging, pgbouncer, realtime, corpus`.
2. Reload the API config and schema cache.
3. Poll the corpus endpoint until it returns 200 instead of 503.
4. Re-run the authenticated app soak (Home, Matters, Research, one agent tool call) to confirm the frontend reads real corpus data again.
5. Only after the API is green, resume the paused storage cleanup (delete `FORAWS`, then `kb-staging`, preserving `matters`).

## Technical notes

- The setting lives on the `authenticator` role as `pgrst.db_extra_search_path` (the exposed-schema list `pgrst.db_schemas` was already corrected to `public, corpus`).
- Applied via `ALTER ROLE authenticator SET ...` followed by `NOTIFY pgrst, 'reload config'` and `NOTIFY pgrst, 'reload schema'`.
- No application code changes are required.
