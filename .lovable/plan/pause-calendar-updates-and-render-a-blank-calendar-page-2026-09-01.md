# Pause calendar updates and render a blank Calendar page

## Goal
Stop the automated DocketBird AutoCalendar refresh and replace the live Calendar UI with a clean blank/placeholder page while keeping the route and backend intact for later re-activation.

## 1. Unschedule the calendar sync cron

Disable the existing `calendar-sync-30m` job on the app's managed database so no further automatic POSTs are made to `/api/public/calendar/sync`.

- Run a one-time SQL statement:
  ```sql
  SELECT cron.unschedule('calendar-sync-30m')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calendar-sync-30m');
  ```
- Verify the job is removed from `cron.job`.
- Leave `public.trigger_calendar_sync()` and the vault secrets in place so the job can be re-enabled later without re-creating infrastructure.

## 2. Render a blank Calendar UI

Update `src/components/calendar/CalendarView.tsx` so the `/calendar` route no longer fetches or displays live calendar data.

- Remove the `useQuery` call to `getCorpusCalendar` and all derived memoized event/matter lists.
- Remove the month grid, agenda list, cases list, filter rail, and day panel renders.
- Keep the page chrome (AppShell, route file, page title) so the navigation and brand remain intact.
- Render a centered, minimal placeholder with the calendar icon and a short line such as "Calendar coming soon." so the page is not a broken-looking empty route.
- Keep imports lean; remove now-unused components/logic.

## 3. Leave backend untouched

- Do not modify `src/lib/calendar.server.ts`, `src/lib/calendar.functions.ts`, `src/routes/api/public/calendar/sync.ts`, `src/components/calendar/MonthGrid.tsx`, `src/components/calendar/DayPanel.tsx`, or `supabase/corpus/calendar-sync-cron.sql`.
- The sync route remains callable manually if needed; only the scheduled trigger is paused.

## Verification

- Typecheck/lint clean.
- Preview `/calendar` shows only the placeholder with no network calls to the calendar server function.
- Query `SELECT * FROM cron.job WHERE jobname = 'calendar-sync-30m';` returns no rows.
