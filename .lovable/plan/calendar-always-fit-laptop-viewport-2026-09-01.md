# Calendar: always fit laptop viewport

## Problem
The new `minmax(96px, 1fr)` row minimum (6 rows = 576px) plus header and filter rail exceeds a ~635px laptop viewport, so the bottom rows are pushed into the internal scroll area and the month never shows in full.

## Fix (`src/components/calendar/MonthGrid.tsx`)
- Remove the fixed 96px row minimum: rows go back to pure `1fr` flex sizing so all 6 week rows always fit the available height exactly — no scroll on any laptop screen.
- Keep the graceful degradation for genuinely short content: each day cell already caps at 3 event pills with a "+N more" link and `overflow-hidden`, so shrinking rows never clip content silently.
- Add a short-viewport tweak: when height is tight, reduce cell padding and pill spacing slightly (e.g. via a compact density using smaller gap/padding) so 3 pills + day number still fit in ~75px rows.
- Keep the internal `overflow-y-auto` fallback only for extremely short windows (< ~500px), where fitting is impossible.

## Verify
- Preview at 970x635 (your laptop size): all 6 rows visible, no scrollbar, no cut-off.
- Re-check 1600x1000 large desktop still fills cleanly.
