# Source Panel: scrollable markdown source cards + in-card citation scroll

## Goal
Rework the right-panel source cards so source text is (1) rendered as clean, compact markdown inside a fixed-height, vertically scrollable region — cards never stretch to full text length — and (2) when a `[S#]` citation is clicked in the answer, the selected card scrolls *inside its own scroll area* to center the highlighted passage, not just into view in the panel.

## Changes

### 1. `src/components/chat/SourcePanel.tsx` — SourceCard rework
- Replace the current `expanded` 200-char-preview ↔ full-text toggle with an always-on **bounded scroll region** for the source text:
  - `max-h-[180px] overflow-y-auto` on the content block; the full source text is always available by scrolling inside the card.
  - When the card is **selected** (citation clicked), the scroll region grows to `max-h-[320px]` with a smooth height animation (framer-motion), so the highlighted passage has more room.
  - Remove the "Show more / Show less" button — no longer needed.
- Render the source text with **ReactMarkdown** (already a dependency, used in `AnswerMarkdown`) with a compact typographic scale tuned for the narrow panel:
  - small headings (`text-[12px] semibold`), tight paragraphs (`my-1.5`), compact lists, subtle blockquote/code styling, consistent with the Seeger Weiss brand tokens already in use.
  - Custom scrollbar styling (thin, muted) so the inner scroll area feels polished.

### 2. Highlight + markdown integration
- The highlight span (`findBestSpan` from `src/lib/highlight.ts`, unchanged) gives raw text offsets. Split content into three segments at those offsets: render **before** as markdown, the **highlighted span** as inline text inside the existing animated `<motion.span>` (same yellow fade-in), and **after** as markdown. Formatting stays clean; highlight behavior is preserved exactly.
- Keep the mark rendering only when the card is selected and a span match exists (current behavior).

### 3. In-card scroll-to-highlight on citation click
- On selection, after the card expands and markdown renders (~120ms delay to let layout settle):
  1. Scroll the card into view in the panel (`scrollIntoView({ block: "nearest" })`) — unchanged.
  2. Compute the highlight mark's offset **relative to the card's inner scroll container** and set `container.scrollTop = markTop - containerHeight/2` with `behavior: "smooth"`, so the cited text lands centered inside the card's own scroll area without yanking the whole panel.
- Keep the "Clear" button and all other affordances (tier badges, View source link, Ask AI popover) untouched.

## No changes to
- Backend / SSE contract, `orchestrate.ts`, `use-chat.ts`, `highlight.ts` matching logic, or any other route/component.

## Verification
- Ask a question in the chat, click multiple `[S#]` citations: confirm the right card is selected, expands, and the inner area scrolls so the highlighted text is centered; confirm cards stay compact in the panel and scroll independently.
- Check long sources render with markdown formatting (headings/lists) and the panel itself still scrolls smoothly with many sources.
- Mobile/narrow viewport: panel remains usable.
