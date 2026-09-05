# Scaling Summarize to many thousands of pages and mixed file types

The 700-page PDF works because everything fits comfortably in one browser tab. At
5k–50k pages the current design breaks in four specific places, all fixable without
changing the compliance rule (nothing persisted to AWS; ephemeral only).

## What breaks today

1. **Search rebuilds the whole index on every query.** `searchPages` calls
   `buildIndex(...)` over every passage each time you search or ask. At 700 pages
   that's a blink; at 20k pages it's several seconds of frozen UI per query.
2. **Page text is stored three times.** Once in `pagesRef`, then twice more in
   `pageTexts` (keyed by file name *and* by file id), and the whole map is
   shallow-copied into React state after every OCR page. That's ~3x memory plus
   O(n²) copying during conversion.
3. **One bad file kills the run.** File extraction runs in a pool that throws on the
   first failure, so a single corrupt PPTX aborts a 40-file upload.
4. **Non-PDF files are page-anchored crudely.** Word is sliced into 3,000-char
   pseudo-pages, and each Excel sheet becomes one giant page — a 40k-row sheet is a
   single retrieval unit, so citations point at "page 1" and ranking is useless.

## The plan

### 1. Build the index once, incrementally

Create a persistent index that is built during ingest and updated in place when OCR
merges recovered text, instead of being rebuilt per query. Queries become a scoring
pass over an existing index rather than a full tokenization of the corpus.

### 2. Move the pile into a Web Worker

At these volumes, tokenizing and scoring must not run on the UI thread. The page
store and the index live in a dedicated worker; the React layer holds only what it
renders (hit list, current page text, counts). This alone is what makes 20k+ pages
feel the same as 700.

### 3. Stop duplicating page text

One canonical page store, keyed by `fileId:page`. `pageTexts` becomes a lookup
function against it, and OCR merges bump a version counter instead of spreading a
whole new object into state.

### 4. Per-file isolation and resumable reading

Each file succeeds or fails on its own: a failed file is marked `error` in the file
list with its reason, and the rest of the pile still indexes and answers. Files are
read in a bounded pool with a memory guard so 40 large files aren't decoded at once.

### 5. Real page anchoring for Word / Excel / PowerPoint

- **Word**: split on headings and page breaks rather than a blind character count, so
  a "page" is a real section and citations mean something.
- **Excel**: chunk each sheet into row blocks (with the header row repeated on every
  block) instead of one page per sheet.
- **PowerPoint**: include speaker notes with each slide.
- Per-format caps so one enormous workbook can't consume the entire page budget.

### 6. OCR that scales past 400 pages

- Fair-share budget across files instead of first-come-first-served, so file 1 can't
  eat the whole cap and leave file 12 unconverted.
- Reuse a single opened PDF handle for text extraction and rasterization (today the
  file is decoded twice).
- Keep the adaptive concurrency (4, floor 2, ceiling 6) that fixed the TLS failures,
  and raise the session cap with pacing rather than a hard stop.
- Per-page failures stay non-fatal and are reported as "unreadable" in the rail.

### 7. Spill to the ephemeral server store above a threshold

Above roughly 8k pages the tab is the wrong place to hold everything. Overflow pages
go to the existing ephemeral server store (local disk, 30-minute TTL, already
implemented in `src/lib/pile/store.ts`) and searches fan out to it. Nothing goes to
AWS; the workspace is deleted on reset and expires on its own.

### 8. Honest capacity reporting

The rail states the real limits it applied: pages read, pages converted, pages
skipped over budget, files that failed, and whether the pile spilled to the ephemeral
store.

## Technical notes

- `src/lib/pile/bm25.ts` — add incremental `addDoc` / `updateDoc` to the index.
- New `src/lib/pile/pile.worker.ts` + a thin client; `client-search.ts` becomes the
  worker protocol rather than a direct call.
- `src/lib/use-pile.ts` — single page store, per-file try/catch, versioned state,
  fair-share OCR budget.
- `src/lib/office-text.ts` — row-block chunking for XLSX, notes for PPTX.
- `src/lib/extract-text.ts` — heading-aware Word pagination; shared PDF handle.
- `src/lib/pile/limits.ts` — per-format caps, spill threshold, raised OCR cap.
- No schema change, no new backend service, no AWS persistence.

## Suggested order

Steps 1–3 give the biggest win and are self-contained; 4–6 harden mixed uploads;
7–8 are only needed if you actually push toward 50k pages in one session.
