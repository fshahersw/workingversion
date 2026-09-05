# Summarize: cleaner, more modern uploader and workbench layout

Presentation-only refinement of the Summarize screen — no changes to ingestion, OCR, search,
or the ask pipeline. The current screen works but reads as a plain card: one big dashed box,
a flat file list, and a progress view that reuses the uploader component in an odd nested card.

## Uploader (idle state)

- Two-zone layout instead of one tall dashed box: a compact drop target on top, with an
  explicit "Browse files" button next to the drag hint (right now the whole box is a click
  target with no visible button, which reads unfinished).
- Format chips move into a single quiet line under the drop target; the page/file/privacy
  limits become one muted caption rather than a paragraph.
- Selected-file list gets real structure: per-type icon and color (PDF / Word / Excel /
  PowerPoint / text), file size, a running total ("6 files · 41.2 MB"), a "Clear all" action,
  and a hover-only remove button instead of an always-on X.
- Duplicate and unsupported picks are flagged inline in the list (greyed row + reason) instead
  of silently dropping later.
- "Focus (optional)" becomes a collapsible row so the default view is short, with two or three
  example prompt chips that fill the field on click.
- Primary action becomes a sticky footer bar inside the card with the file/page count on the
  left and the Index button on the right.

## Ingest progress (reading / indexing)

- Replace the nested "Building a temporary working set" card + reused DropPanel with a
  dedicated progress panel: one header row with an overall determinate bar and page counter,
  then a compact per-file row list (icon, name, page count, state).
- Per-file states get distinct treatment: reading (bar), converting scanned pages (bar with
  OCR badge), ready (check + page count), error (red row with the message and the note that
  the rest of the pile continues).
- Error rows are collapsed into "N files skipped — show" when more than three fail.

## Workbench (ready state)

- Sticky toolbar row: pile summary chip (files · pages · scanned pages recovered), search input,
  Search and Ask buttons, and a right-aligned overflow with "Add files" and "Clear session"
  (Clear session moves out of the loose bottom-right button).
- Results area gets a small header ("12 pages · ranked by relevance") and source cards get
  cleaner hierarchy: cite badge, filename, page, badges on one line; snippet in a lighter tone;
  expanded page text in a subtly tinted reading surface with the existing highlight behavior.
- Right rail gets two clearly separated blocks — Structure (inventory as a tidy definition list,
  parties/dates as chips) and Reasoning — with a sticky section label so it stays legible when
  the rail scrolls.
- Below 1024px the rail collapses into a "Show reasoning" disclosure under the results instead
  of stacking a tall column.

## Visual language

Everlaw/Westlaw-style restraint using existing tokens only: tighter radii on dense elements,
1px hairline borders, single soft shadow reserved for the primary card, no new colors beyond
`brand-navy` / `brand-orange` / muted / border already in `src/styles.css`, and consistent
type scale (13px body, 11px meta, uppercase 10px section labels).

## Technical notes

- Files touched: `src/components/summarize/DropPanel.tsx` (uploader split from progress),
  a new `src/components/summarize/IngestProgress.tsx`, `src/components/summarize/SummarizeView.tsx`
  (toolbar, grid, responsive rail), `src/components/summarize/ReasoningRail.tsx` (sticky label,
  spacing). Structure block moves out of `SummarizeView` into a small `StructureRail` component.
- `usePile` and every file under `src/lib/pile/` stay untouched; the new progress panel reads the
  same `state.files` / `state.steps` shape already exposed, including the `error` field.
- Motion stays with the existing framer-motion easing constant; no new dependencies.
