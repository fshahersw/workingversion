# Matters page — remove manual upload, polish UI/UX, real in-page PDF viewer

Scope: `src/components/matters/MatterWorkspace.tsx`, deletion of `src/components/matters/UploadDropzone.tsx`, and a new `src/components/matters/PdfViewer.tsx`. No changes to data loading, queries, routing, search params, or the ingest pipeline — display only.

## 1. Remove manual PDF upload from the Matters UI

- Delete the "Upload PDFs" header button, the collapsible `UploadDropzone` panel, the `uploadOpen` state, and the `UploadDropzone.tsx` file (it's referenced nowhere else — verified).
- Update the two empty-state messages that say "Upload the matter's PDFs above…" to neutral copy ("Docket entries will appear here once the ingest pipeline processes this matter's filings."). The external ETL pipeline and `getUploadUrls` server function stay untouched.

## 2. New in-page PDF viewer (replaces the iframe + "Open in tab")

Replace the bare `<iframe>` with a canvas-based viewer built on pdf.js — the project already ships `pdfjs-dist`, `pdf-worker.ts` (`configurePdfjsWorker`), and `pdf-compat.ts` (`ensurePromiseWithResolvers`), so this reuses existing, proven plumbing and renders crisp at any zoom.

Viewer contract:
- **Always centered**: pages render horizontally centered in a `overflow-y-auto` pane with a soft neutral canvas backdrop, document page sitting on a white "paper" card with a subtle shadow.
- **Always starts right**: every document opens at page 1, scrolled to top, zoom = fit-to-width.
- **Controls, all in-page** (no "Open in tab" — that link is removed): a slim toolbar with page stepper (‹ 3 / 24 ›), direct page input, zoom out/in with % readout, and "Fit width" reset. Keyboard: ←/→ page, +/- zoom while the pane is focused.
- **Smooth**: pages render progressively (only pages near the viewport are rasterized via IntersectionObserver), so a 200-page filing stays fast; a subtle shimmer placeholder shows per pending page instead of a single dead spinner.
- Presigned URL comes from the existing `documentViewUrlQueryOptions` unchanged.

## 3. Simplify & polish the workspace

**Header (leaner)**
- Drop redundant metadata chips from the header (court, judge, date range already live in the right rail): keep short name, stage/status badges, case caption, docket/MDL number, court.

**Toolbar (one clean row)**
- Tabs + search stay. Collapse the type-facet chips into a single "Filters" dropdown with checkboxes and counts instead of a second scrolling chip row — the toolbar becomes one row, freeing vertical space.
- Keep docket selector (All / Main / JPML), PDF toggle, and Oldest/Newest toggle as-is.

**Tables (smoother, more readable)**
- Subtle zebra striping and slightly taller rows for scannability.
- Replace the opacity-fade on refetch with a thin top loading bar, so rows don't visibly flicker when paging/searching.
- Skeleton rows on first load instead of a bare spinner.
- Expanded entry/document viewer: smooth height+opacity transition so it doesn't snap open.

**Right rail**
- Slightly narrower (280px), grouped cards with consistent section spacing; content identical.

**Speed (rendering only)**
- Memoize `LedgerRow`/`DocRow` so typing in the search box doesn't re-render 50 rows per keystroke.

## What does NOT change
- All query options, server functions, URL search params, pagination, expansion behavior, presigned-URL flow, and data shapes remain the same.
- The ingest pipeline, upload endpoint, and external ETL contract are untouched.

## Verification
- Typecheck, then a browser pass over `/matters/<slug>`: confirm upload UI is gone; expand a ledger entry and a document row — PDF opens centered at page 1 top at fit-width, page/zoom controls work, no "Open in tab"; toolbar fits one row; filters, expansion, and pagination still work.
