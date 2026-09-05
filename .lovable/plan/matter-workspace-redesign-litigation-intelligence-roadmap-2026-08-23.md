# Matter workspace: redesign + litigation intelligence roadmap

## What I verified in the live registry first

- This matter (AFFF/PFAS MDL 2873) has **1,997 docket entries** and **167 documents**, but **0 parties and 0 counsel rows** — the tabs aren't broken, the corpus simply has no party/counsel records for MDL master dockets. Corpus-wide there are only 325 parties, 489 counsel appearances, 68 judicial assignments, 25 outcomes across 73 matters, and those cluster on member cases, not masters.
- Every `documents` row **does** carry a `docket_entry_id` (verified on real rows), so documents can be nested under their docket entry. Today the Documents tab is a flat list and `documentCount` on docket entries is hardcoded to `0` — that's exactly the "documents don't match the docket" problem.
- Docket entries have **no date column**; dates only sometimes appear as `(Entered: MM/DD/YYYY)` inside the description, and long entries are wrapped in "This Order Relates to Case Numbers: (...)" noise that makes rows unreadable.
- `loadMatterDetail` calls `loadOverview()` first, which pulls every docket-entry and document id in the corpus (~38k rows) on every matter page load. At 2,500 matters this design will not survive.

## Phase 1 — Rebuild the matter page (this pass)

### Single unified Docket + Documents view

Replace the two disconnected tabs with one **filing register**: each docket entry is a row, its attached documents nest inside it as expandable child rows with size, verification badge, and a download action. Columns: entry #, entered date, filing type, description, attachments count. Row expansion reveals full untruncated text plus per-document actions.

- Real attachment counts: fetch document counts grouped by `docket_entry_id` for the page's entries instead of `0`.
- **Filing-type classification** derived from the description (Order, Motion, Complaint, Notice, Stipulation, Letter, Transcript, Case Management Order, Minute Entry, Exhibit...), rendered as quiet type chips and exposed as a left filter rail with counts — the Docket Alarm / Docket Key pattern in your reference screenshots.
- Description cleanup: strip the `This Order Relates to Case Numbers: (...)` tail into a collapsible "relates to N member cases" affordance, strip `(Entered: ...)` into the date column.
- Left filter rail (sticky, collapsible): filing type, has-documents, date range, entry-number range, full-text keyword. Result count header, "Clear all filters".
- Documents-only toggle for people who want the flat file view.

### Honest, informative empty states

Parties / Counsel render "No party records in the registry for this master docket" with a link to the member cases that *do* have them, plus an inline count. Never a blank panel.

### Page frame

- Sticky matter header: caption, court, docket number, judge, status, filed date, MDL member count — always visible while scrolling.
- Left rail: filters. Center: register. Right rail: matter intelligence (below).
- Density, alignment, and typography tuned to the Docket Alarm / Lexis reference shots: 32px rows, zebra, ruled columns, quiet slate/navy palette, no bulky cards.
- Fix the hydration mismatch on the greeting ("Good afternoon" vs "Good evening") by rendering the time-based greeting after mount.

### Right rail: matter intelligence

- Vital stats (entries, documents, parties, related cases, first/last filing).
- Related / MDL member matters with links.
- "Ask the research agent about this matter" with matter-scoped context prefilled (already wired — restyled).

## Phase 2 — Capabilities roadmap (scoped for 2,500 matters + case law corpus)

Grounded in what the leading platforms actually ship (Relativity aiR for Case Strategy, Everlaw Storybuilder deposition + fact timelines, Docket Alarm analytics, Clearbrief citation verification):

1. **Case chronology / fact timeline** — agent extracts dated events from docket text and document OCR into a Facts table (date, event, source doc, confidence, party). Editable, filterable, exportable to a chronology memo. This is the highest-leverage feature and maps directly to Storybuilder Facts and aiR for Case Strategy.
2. **Deposition prep workspace** — pick a witness/party, agent drafts an outline and question sets from documents and prior testimony, each question linked to its exhibit; export to Word.
3. **Bulk docket comparison** — select N matters (e.g. all AFFF member cases), diff their posture: what's filed where, which cases lack a PFS, scheduling-order deltas, motion outcomes side by side.
4. **Judge & court analytics** — from the backfill: judge's motion grant rates, median time-to-ruling, standing orders, form requirements, per-court filing-type mix.
5. **Document intelligence layer** — background OCR + embedding of the FORAWS objects, so documents are semantically searchable and citable, with pinpoint page/paragraph cites.
6. **Cross-corpus research agent** — one retrieval surface over dockets, case law, state codes, regulations, and Congress, with a strict citation contract and verification pass (Clearbrief-style: every assertion links to a source span).
7. **Docket monitoring & alerts** — new-filing watchlists per matter, digest of what moved this week, deadline extraction from scheduling orders.
8. **Saved searches, tags, work product** — persist filters, tag filings into issues, assemble issue maps that feed the timeline and deposition tools.

## Phase 3 — Scale prerequisites (needed before 2,500 matters land)

- Stop loading the whole corpus per page: matter detail fetches only its own matter row plus joins; list page moves to server-side pagination, search, and sort with PostgREST `count=planned`.
- Push counts into database views (`matter_stats`, `docket_entry_document_counts`) so the UI reads one row instead of aggregating 38k.
- Add a full-text index on `docket_entries.description` and search via it rather than `ilike`.
- Keep credentials server-side (they already are) and add caching per matter.

## Technical notes

- Rewrite `src/components/matters/MatterDetail.tsx` into `src/components/matters/` parts: `MatterHeader`, `FilterRail`, `FilingRegister`, `FilingRow`, `MatterIntelRail`.
- Extend `src/lib/corpus.server.ts` with `loadFilings(matterId, filters, page)` returning entries with nested documents and a facet tally; add filing-type classification in a new `src/lib/filing-types.ts`.
- Add `getMatterFilings` to `src/lib/corpus.functions.ts`; query options in `src/lib/matters-corpus.ts`.
- Existing tokens only (`brand-navy`, `brand-blue-soft`, slate neutrals); no new color system.

## What I'd like to confirm

Phase 1 is the build I'd start now. Phases 2 and 3 are the roadmap — tell me which capability you want first (my recommendation: chronology/fact timeline, then bulk docket comparison) and I'll plan that in detail next.
