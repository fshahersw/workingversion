# 15 results per Ask, bigger writer budget, reliable multi-file picking

## 1. Fifteen cited results per Ask

- `src/lib/pile/limits.ts`: `ASK_MIN_HITS` 12 -> 15, `PER_FILE_ASK_PAGES` 12 -> 15,
  and raise `perFilePages` to 15 in the 1-file and 2-5 file tiers of `askBudget`
  so single-file and small piles surface 15 hits.
- `src/lib/use-pile.ts` already passes `Math.max(budget.perFilePages, ASK_MIN_HITS)`,
  so no change needed there.
- The relevance floor stays: a document with only 6 real matches still returns 6,
  not 15 padded pages.

## 2. Token budget increases

- `src/lib/pile/ask.server.ts`:
  - Final Sonnet 5 writer calls (single-file and cross-file synthesis):
    `maxTokens: 12000` -> `20000`.
  - Per-file reader: `maxTokens: 4000` -> `12000`.
  - Short digest call: `maxTokens: 1200` -> `8000`.

## 3. Upload component drops files (fix)

Current behavior in `src/components/summarize/DropPanel.tsx` that causes files to
go missing when several are added at once:

- Every add is silently truncated with `.slice(0, MAX_FILES)` — files past the cap
  disappear with no message.
- Re-picking a file that is already in the list marks it "duplicate" and it is
  excluded, which reads as "it didn't register".
- Dropping a folder (or dragging from some apps) yields no entries in
  `dataTransfer.files`, so the drop appears to do nothing.
- Two rapid `add()` calls are safe today (functional setState), but the picker
  input has no per-add feedback, so a partial result is invisible.

Changes:

- Merge new files into existing ones with a real dedupe on name + size + last
  modified, keeping the first copy, and count how many were skipped as already
  added rather than listing them as broken rows.
- Read dropped items through `DataTransferItemList` with directory traversal so
  folder drops enumerate the files inside; fall back to `dataTransfer.files`.
- When a batch exceeds `MAX_FILES` or the byte cap, keep what fits and show an
  explicit banner naming how many were not added and why.
- Show a short "Added N files" confirmation line after each add, and a count of
  unsupported types, so a partial add is always visible.
- Keep the existing layout, brand styling, focus panel, and Index button
  behavior unchanged.

## 4. Verification

- Run the pile test suite and a typecheck.
- Update `src/lib/pile/client-search.test.ts` expectations from 12 to 15 hits.
- Browser check: select 20+ mixed files in one dialog, confirm the list count
  matches the selection, add the same set again and confirm the skip notice
  instead of vanishing rows, then run an Ask and confirm 15 cited pages.
