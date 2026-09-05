# Wire the Calendar Auto-Sync Cron on this app's own database

Instead of applying `supabase/corpus/calendar-sync-cron.sql` by hand on the external corpus database, schedule it on this app's built-in backend database. Same result: the job just makes one HTTP call to `/api/public/calendar/sync`, and the route itself writes into the corpus calendar table.

This is the pattern the existing intel refresh already uses on this database (`trigger_intel_run()` → vault secrets → pg_net HTTP POST → pg_cron schedule), so it's proven here.

## Steps

1. **Store config in the vault** (values only, no schema change):
   - `calendar_sync_url` → `https://project--69032d3d-8ec5-49b7-9ecb-806e580dd3cd.lovable.app/api/public/calendar/sync` (stable published URL, immune to renames)
   - `calendar_sync_key` → the existing `INGEST_API_KEY` value, so it never appears in cron job text
2. **Create `public.trigger_calendar_sync()`** — security-definer, mirrors `trigger_intel_run()`: reads both vault secrets, exits quietly with a notice if either is missing, otherwise POSTs `{}` with `content-type` and `x-ingest-key` headers and a 5-minute timeout. Execute is revoked from `PUBLIC`/`anon`/`authenticated`.
3. **Schedule it**: `cron.schedule('calendar-sync-30m', '*/30 * * * *', ...)`, unscheduled first so re-applying is safe. `pg_cron` and `pg_net` are already enabled on this database (the intel job uses them).
4. **Verify end-to-end**:
   - job row present and active in `cron.job`
   - fire `trigger_calendar_sync()` once manually
   - read back the pg_net response — expect HTTP 200 with `{"ok":true,...}`
   - confirm the Calendar page's "refreshed" timestamp moves

## Safety notes

- Nothing about the corpus schema, the sync route, or the Calendar UI changes — this only adds a scheduled caller.
- The route already fails safe: if DocketBird is unreachable it returns a JSON error and leaves the cached calendar untouched.
- Idempotent: re-running unschedules then reschedules; no duplicate jobs.
- Cadence is every 30 minutes (48 calls/day). Each run is a single cheap HTTP call, and DocketBird calendar entries rarely change intraday — comfortable freshness/cost balance, easy to relax to hourly later.
- `supabase/corpus/calendar-sync-cron.sql` stays in the repo as documentation in case you later want the job to live on the corpus database instead.

## Technical details

- Applied as a one-time SQL statement (vault values are runtime config, not a schema migration); the function definition goes in as part of the same apply.
- The secret name reused is `INGEST_API_KEY`, the same key `requireIngestAuth` checks in `src/lib/ingest/store.server.ts`.
- If you later publish a new version, the URL keeps working — the published domain is stable.
