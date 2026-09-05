# Calendar: fit-to-screen layout

## Goal
Make the calendar page fill the available viewport on large screens with no page-level scroll, and fall back to a contained vertical scroll only when content genuinely overflows (short windows, many events in a day cell).

## Changes

### 1. Height-bound the calendar shell (`src/components/calendar/CalendarView.tsx`)
- The root already uses `h-full min-h-0 flex-col overflow-hidden` — verify the parent route/container actually constrains height; if the page grows past the viewport, cap it (e.g. `h-[calc(100dvh-<header offset>)]` or ensure the authenticated shell gives the route a bounded flex column).
- Header, toolbar, and filter rail stay fixed; only the content region (`min-h-0 flex-1`) scrolls.

### 2. Month grid fit + graceful overflow (`src/components/calendar/MonthGrid.tsx`)
- Keep the 6-row × 7-col grid filling available height, but give rows a sensible minimum (~`minmax(96px, 1fr)`) so cells never crush.
- When a day's events exceed the cell, keep the existing in-cell `overflow-hidden` but add a "+N more" indicator so nothing is silently clipped; clicking the day opens the day panel with the full list.
- If the viewport is very short, the grid container gets `overflow-y-auto` so the page scrolls internally rather than pushing the whole layout.

### 3. Agenda / case views
- Already `h-full overflow-y-auto` — confirm they stay internally scrollable and never trigger whole-page scroll.

### 4. Verify
- Preview at desktop and short-viewport sizes: month view fits with no scrollbar on large screens; scroll appears only inside the calendar when needed.

## Note: the ingest key
No — the ingest key is **not** the DocketBird API key. It's the shared `INGEST_API_KEY` secret that protects the `/api/public/calendar/sync` endpoint (checked as the `X-Ingest-Key` header). The sync route itself uses the DocketBird key server-side. So for the corpus cron SQL, use the same value as the `INGEST_API_KEY` secret in the backend.
