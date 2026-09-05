# Wire calendar auto-sync + clean up the Calendar page

## 1. Schedule the DocketBird calendar sync (on the corpus database)

Today `/api/public/calendar/sync` exists and works, but nothing calls it — the cached firm AutoCalendar only refreshes when someone runs the script by hand. Schedule it from the **corpus Supabase account** (the same database that holds `corpus.calendar_entries` and the matter/docket files), not Lovable Cloud.

- Add a new idempotent SQL file `supabase/corpus/calendar-sync-cron.sql`, matching the existing `supabase/corpus/*.sql` convention (applied with `psql "$CORPUS_DB_URL" -f ...`).
- It enables `pg_cron` and `pg_net` on the corpus database, stores the sync URL and the ingest key in that database's vault, and defines a small `trigger_calendar_sync()` function that posts to the route with the `X-Ingest-Key` header.
- Schedule: every 30 minutes (`*/30 * * * *`), unscheduled-then-scheduled so re-running the file is safe.
- Target the stable app URL (`project--<id>.lovable.app/api/public/calendar/sync`) so renames never break it.
- The ingest key value is supplied at apply time (psql variable), so the secret is never committed to the repo.
- Verify by reading `cron.job` / `cron.job_run_details` on the corpus database and confirming the cached calendar's "refreshed" timestamp moves.

Nothing is added to the Lovable Cloud database.


Failure behavior stays safe: the route already returns a JSON error and leaves the existing cache untouched if DocketBird is unreachable.

## 2. Calendar page UI polish (presentation only)

Keep every current behavior — month/agenda/cases modes, horizon filter, matter chips, day panel, case links — and tighten the presentation:

- **Unified header.** One consistent header row across all three modes: title block on the left (Calendar + "Firm AutoCalendar · refreshed …"), month navigation (‹ › Today + month name) shown inline only in month mode instead of replacing the whole header. Removes the current jarring layout swap between modes.
- **Toolbar grouping.** Move the view switch and the horizon switch into a single right-aligned toolbar with matching pill sizing, and keep the horizon control mounted (disabled/hidden gracefully) so the toolbar does not jump width when switching modes.
- **Filter rail.** Replace the free-flowing wrapped chip cloud with a single-line, horizontally scrollable filter rail: the two scope chips ("All followed", "In workspace") pinned on the left with a divider, then matter chips. Caps the header at a fixed height and stops the grid from being pushed down when many matters exist.
- **Month grid.** Slightly larger day cells with better spacing, quieter out-of-month days, a clearer today marker, consistent event-pill typography and truncation, and a tidier "+N more" affordance.
- **Agenda / cases lists.** Consistent row rhythm, aligned time column, subtler dividers, and a matter color bar in agenda groups to match the cases view.
- **States.** Match the loading skeleton and empty state to the rest of the app (centered, icon + short copy) instead of the current left-aligned spinner line.

No changes to data fetching, filtering logic, routes, or the sync payload.

## Technical notes

- Files touched: `src/components/calendar/CalendarView.tsx`, `MonthGrid.tsx`, `DayPanel.tsx` (styling/layout only), plus one new `supabase/corpus/calendar-sync-cron.sql` applied against the corpus database.
- No Lovable Cloud migration; `src/lib/calendar.server.ts`, `calendar.functions.ts`, and the sync route are unchanged.
- Verification: typecheck + lint clean, visual check of all three modes in the preview, and confirmation on the corpus database that the scheduled job is registered and firing.
