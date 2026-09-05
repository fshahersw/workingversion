# Fix default Filing register sort to newest first

## Goal
Change the default sort on the **Filing register** tab (Matter detail page) so it always opens with the newest filings at the top — highest docket entry number first, descending to oldest.

## What will change
1. In `src/components/matters/MatterDetail.tsx`, update the `FilingRegister` default filter state:
   - `sort` defaults from `"entry-asc"` to `"entry-desc"`.
2. Reorder/relabel the sort `<select>` so the new default is the first option and clearly reads as newest-first.
   - Option order: `entry-desc` (Newest entry first), `date-desc` (Newest entered), `entry-asc` (Entry no. ascending).
3. Keep the existing backend sort handling in `src/lib/corpus.server.ts` unchanged; it already supports `entry-desc` and sorts by `entrySort` descending.

## Verification
- Open any matter detail page and switch to the **Filing register** tab.
- Confirm the first visible entry is the highest entry number and the sort dropdown shows `entry-desc` / "Newest entry first".
- Confirm switching to ascending and back still works, and pagination preserves the chosen sort.
