# Discovery / Summarize: production-grade review UI

Reshape the Summarize tab into the three-pane review layout from the reference screenshots — a left
refine rail, a centered Find passages / Ask workspace, and a right document reader with keyword
highlighting. This is a presentation and interaction change on top of the pile pipeline that already
exists; ingestion, BM25 search, and the ask/synthesis path stay exactly as they are.

## What exists today (verified)

- `SummarizeView.tsx` is a two-column screen: one search box that runs either Search or Ask, a
  scrolling list of expandable source cards, and a right rail with Structure + Reasoning.
- `usePile` already exposes everything the new layout needs: `state.files`, `state.groups`
  (per-file hits with `matched`, `topScore`, `pageCount`), `state.hits`, `state.pageTexts`
  (full page text keyed `fileId:page`), `state.selected`, and `state.structure`.
- `PileStructure.inventory` already carries a `docType` per file, and `PileFile` carries
  `pageCount`, `ocrPages`, `emptyPages` — so document-type facets and index counts can be
  derived client-side with no backend or schema change.

## New layout

```text
┌──────────────┬───────────────────────────────┬──────────────────────┐
│ REFINE       │  [Find passages] [Ask]        │  DOCUMENT READER     │
│              │  ┌─────────────────────────┐  │  Exhibit B …pdf   ✕  │
│ Document type│  │ query…            [Ask] │  │  PDF · 5 pp          │
│  Exhibit  5  │  └─────────────────────────┘  │  ‹ 2 / 5 ›  4 pages  │
│  Notice   5  │  105 matches · 24 of 30 docs  │      with hits ▲▼    │
│  Order    1  │                               │                      │
│              │  ▸ 0017-002 Exhibit B         │  full page text with │
│ File format  │     p.2 …passage…             │  every query term    │
│  PDF     30  │     p.2 …passage…             │  highlighted, click  │
│              │     Show 22 more passages     │  to jump hit to hit  │
│ Index        │  ▸ 0017-008 Exhibit H         │                      │
│  Readable 30 │                               │  [Copy]              │
│  Pages   730 │                               │                      │
└──────────────┴───────────────────────────────┴──────────────────────┘
```

### Left refine rail

- Facet groups: Document type (from `structure.inventory[].docType`, "Unclassified" for files the
  structure pass did not label), File format (from the extension), and a quiet Index block with
  Readable / Pages / Characters / Unreadable counts.
- Checkbox facets filter the visible result groups client-side; counts stay visible when filtered.
- Collapses to a slide-over sheet below `lg`, with a Refine button in the toolbar.

### Center workspace

- The single search box becomes a two-mode toggle: **Find passages** (lexical BM25, current
  `search()`) and **Ask** (current `ask()`), with a mode-specific hint line — "Exact phrase, then
  every significant term" vs "Answered only from your indexed documents".
- Result header shows the real counts: `N matches across M of K documents`.
- Results stay grouped by document (existing `state.groups`), but the group card is tightened:
  filename row, then up to 3 passages, then "Show N more passages". Passages are compact rows with
  a `page N` label and the snippet, not expandable accordions.
- In Ask mode, the answer renders first with a `grounded citations` chip and `from N passages
  across M documents` meta, then the cited source cards with Open page / Pin actions.
- An Indexed documents list at the bottom shows every file with size, pages, characters, its type
  badge, and open/remove actions.

### Right document reader

- Replaces the inline accordion expansion. Selecting a passage or "Open page" opens a right panel
  (overlay above `lg`-, docked column above `xl`) that renders the full page text from
  `state.pageTexts` with all query terms highlighted.
- Page stepper `‹ 2 / 5 ›`, a "N on this page · M pages with hits" readout, and ▲▼ to jump between
  hit pages inside that document.
- Copy button for the selection; "Pin selection" is included only if you want work product now —
  otherwise it is left out of this pass (see open question).

### Reasoning + structure

The existing Reasoning rail and parties/dates chips move under the refine rail as a collapsible
"Run detail" block, so the reasoning stream stays available without owning a full column.

## Technical notes

- Files touched: `src/components/summarize/SummarizeView.tsx` (split into a layout shell),
  new `RefineRail.tsx`, `ResultsPane.tsx`, `DocumentReader.tsx`, `ModeToggle.tsx`; existing
  `StructureRail.tsx` / `ReasoningRail.tsx` reused inside the refine column.
- `src/lib/use-pile.ts` and everything under `src/lib/pile/` stay untouched. Facet counts, format
  detection, per-file hit-page lists, and mode state are all derived in the view layer.
- Highlighting reuses the existing `Highlight` helper, extracted to `src/lib/pile-render.ts`
  neighbours so both the passage rows and the reader share one implementation.
- Tokens only — `brand-navy`, `brand-orange`, muted, border from `src/styles.css`. Dense type scale
  (13px body, 11px meta, 10px uppercase labels), hairline borders, mono for counts.

## Open questions

1. **Classification** — should document types come only from the existing structure pass, or do you
   want an explicit "Classify" action that runs a cheap per-document type/summary pass (as in the
   screenshot) so every file gets a label and a one-line description?
2. **Pinning / work product** — the reference has Pin and a Work product tray. Include pinning in
   this pass (session-scoped, cleared with the pile), or keep it UI-only for now?
