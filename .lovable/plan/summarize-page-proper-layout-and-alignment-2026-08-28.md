# Summarize page: proper layout and alignment

The current page has real structural problems, not just styling: the working area is pinned to the top-left of a very tall empty column, the reasoning rail sits there empty with a lonely paragraph, the drop zone and controls are different widths/rhythms, and roughly 60% of the screen is dead space before you upload anything.

## 1. Fix the layout shell

- Before a run starts, drop the two-column grid entirely. The upload workspace becomes a single centered column (max ~680px) vertically centered in the available height, so the page looks composed instead of top-anchored.
- The reasoning rail only appears once a run begins (reading / thinking / writing / done). Once it appears, the grid animates in as content + 340px rail.
- After a run, the left column takes the full remaining height with its own scroll; the rail scrolls independently. No page-level scroll.

## 2. Rebuild the upload card

- Wrap drop zone, focus box, mode picker, and the action button in one bordered card so everything shares the same width and inner padding — currently they are loose siblings with inconsistent edges.
- Drop zone: taller, centered icon + headline + hint, dashed border only inside the card (no nested double borders).
- Focus textarea: no separate heavy border; sits inside the card under a small "Focus (optional)" label.
- Footer row of the card: segmented mode control on the left, estimate text on the right, both on one baseline.
- Primary button: full width of the card, only enabled with files; disabled state uses muted tokens instead of the current heavy slate fill that reads like an active button.

## 3. Header and rail polish

- Page header aligns to the same max width as the card when idle, so title and card share a left edge.
- Rail: keep the "Reasoning" rule-label, but the explanatory paragraph only shows when there are no steps yet and the run is active — remove it from the idle screen.
- Steps get consistent left gutter (status dot column) so labels align vertically down the rail.

## 4. Result state alignment

- Summary panel header, memo body, conflicts, and key facts all share one card container and one horizontal padding value.
- Key facts: fixed-width kind column, page column right-aligned, claim column flexible — already close, just aligned to the same padding as the memo body.

## Technical notes

Files: `src/components/summarize/SummarizeView.tsx` (layout shell, conditional rail, centering), `src/components/summarize/DropPanel.tsx` (single card, spacing, button states), `src/components/summarize/ReasoningRail.tsx` (idle copy, gutter alignment), `src/components/summarize/SummaryPanel.tsx` (padding consistency). Presentation only — no changes to summarizer logic, SSE, or prompts. Verify with a typecheck and screenshots of idle, running, and completed states.
