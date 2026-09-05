# Summarize page: quieter reasoning rail + UI polish

## 1. Remove the "Reading engine" prose

In `src/lib/use-summarizer.ts` (the `engine` SSE handler, ~line 260-272), drop the "Fireworks reads the pages · Claude writes the memo · every section read twice and cross-checked" step entirely — the engine event is consumed silently (used only for internal state if needed) and no rail step is created for it. This matches the same treatment we gave the research timeline: the rail shows work steps (planning, passes, reduction, writing), not provider commentary.

## 2. UI improvements for /summarize

**Reasoning rail (right panel)**
- Remove the per-pass `detail` preview prose (the clipped 3-line paragraph under each "Pass N · pages X–Y" row). Keep label, tier meta chip, shimmer/check status only — consistent with the research timeline cleanup.
- Keep: questions box, gaps box, live shimmer line.

**Drop panel (empty state)**
- Flatten the mode picker: replace the three bordered cards with a single segmented control row (Fast / Standard / Thorough) with the time estimate inline (`~2-4 min`), and move the long descriptions into a hover tooltip or remove them.
- Soften the drop zone: thinner dashed border, smaller icon, tighter vertical padding; keep drag hover state.
- Merge the "Estimated ~N passes · ~M API calls · ~X min" strip into one quiet line under the mode picker; remove the "k chars" figure (meaningless to a lawyer).

**Summary panel**
- Header: keep title + meta, tighten the button row (Copy / Markdown / New become icon buttons with tooltips to save horizontal space).
- Key facts table: remove the heavy bordered container, use plain divided rows like the research source rows; kind column gets a small colored dot instead of uppercase text.
- Conflicts box: keep, but match the same flatter styling (no heavy amber fill, just an amber left border).

**Layout**
- Widen the right rail from 320px to 340px and give the rail its own scroll only after the summary exists (matches research behavior).
- While `reading`, show the file progress list in the left panel as-is but with the same flatter row styling.

## Technical notes

- Files touched: `src/lib/use-summarizer.ts` (drop engine step + section detail), `src/components/summarize/DropPanel.tsx` (segmented modes, tighter drop zone), `src/components/summarize/SummaryPanel.tsx` (header, facts/conflicts styling), `src/components/summarize/SummarizeView.tsx` (rail width), possibly `src/components/summarize/ReasoningRail.tsx` (no detail rendering).
- No backend, SSE, or prompt changes. Verify with typecheck and a visual pass on `/summarize`.
