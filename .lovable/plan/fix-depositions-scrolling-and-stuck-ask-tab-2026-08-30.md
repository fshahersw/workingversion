# Fix Depositions scrolling and stuck "Ask" tab

Two separate bugs are causing what you're seeing after asking a question across multiple transcripts.

## 1. You can't click away from Ask

The analysis pane force-selects the **Ask** tab whenever an answer exists. The effect that does this depends on the `onTabChange` callback, which the parent recreates on every render — so the effect re-fires continuously and snaps the selection back to Ask the moment you click Summary, Admissions, etc.

Fix: only auto-jump to Ask on the *transition* into asking (track the previous asking state / answer identity), and keep the callback stable in `DepositionView` with `useCallback`. After the jump, manual tab clicks stick.

## 2. Vertical scrolling gets stuck

The analysis pane's root `<section>` is a grid item with no `overflow-hidden` and no height clamp, so when a long answer renders, the inner scroll container grows past the workbench instead of scrolling inside it. The scroll wheel then hits a container that has nothing left to scroll and the whole page feels frozen. The left tab rail also has no scroll of its own.

Fix (layout only):
- Add `overflow-hidden` + `h-full min-h-0` to the analysis pane `<section>` so the inner `wr-app-scroll` region is the actual scroller.
- Give the tab rail its own `overflow-y-auto` so it can't stretch the row.
- Add `min-h-0 overflow-hidden` to the two grid children in `DepositionView` (transcript pane and analysis pane) so neither can push the grid row taller than the workbench.
- Ensure the Discovery tab panel (`DocsWorkspace`) passes a proper `h-full min-h-0` down to the deposition view so the whole column is height-bounded.

## Technical notes

Files touched: `src/components/summarize/DepositionAnalysisPane.tsx`, `src/components/summarize/DepositionView.tsx`, `src/components/docs/DocsWorkspace.tsx`, and possibly `src/components/summarize/TranscriptPane.tsx` for the matching `min-h-0`. No changes to analysis logic, retrieval, prompts, or the API.
