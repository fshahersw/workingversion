# Scale prerequisites: survive 2,500 matters + full docket corpus

The next 2,500 matters land in ~30 minutes, so this pass is about making every page read only what it displays.

## What's slow today (verified in the code)

- `loadOverview()` pulls the entire corpus on every Matters page load: all matters, all courts, judges, judicial assignments, parties, counsel appearances, firms, **every `docket_entries` row**, **every `documents` row**, and all relationships — paged 1,000 at a time and counted in JS. At today's ~38k docket rows that's already heavy; at 2,500 matters it becomes hundreds of thousands of rows per page view.
- The Matters list filters, searches, and sorts entirely in the browser over that full array.
- `loadFilings()` pulls every docket entry (cap 20,000) and every document for the matter, then filters, facets, sorts, and paginates in JS — fine for 2k entries, wasteful for a large master docket.
- Search uses `ilike` scans with no index behind them.

## The build

### 1. Server-side Matters list

Replace `loadOverview` on the list page with `loadMatterPage({ search, court, status, role, firm, sort, offset, limit })`:

- One PostgREST request against `matters` with `Range` headers and `Prefer: count=planned`, returning 50 rows plus a total.
- Search, court/status/role filters, and sort pushed into query params instead of JS.
- Court and judge names resolved with a small batched lookup for only the ids on the page (courts/judges/firms lists stay cached in memory — they're small and change rarely).
- Corpus-wide stat tiles (matters, entries, documents, parties) come from cheap `count=planned` HEAD requests, not by downloading rows.

### 2. Per-matter counts from the database, not JS

Counts on each row (parties / docket entries / documents / MDL members) stop being computed by tallying full tables. They read from a `matter_stats` view in the registry schema. Until that view exists the UI shows counts only where already known, rather than scanning the corpus to fabricate them.

### 3. Server-side filing register

`loadFilings` gets true pagination:

- Filters (search, date range, has-documents) go into the PostgREST query; `Range` returns just the page.
- Type facets and first/last filing date come from one lightweight aggregate call instead of loading all entries.
- Documents are fetched only for the entry ids on the current page (`docket_entry_id=in.(...)`).
- Filing-type filtering, which is derived text classification and can't be expressed in SQL yet, is applied over a bounded window and clearly capped rather than silently loading 20k rows.

### 4. Caching + request hygiene

- Short server-side in-memory cache (60s) for corpus-wide counts and the courts/judges/firms lookup tables.
- React Query keeps `placeholderData` so paging doesn't flash empty.
- Loader-level prefetch stays, but only for the first page.

### 5. Database objects for the corpus project (SQL I'll hand you)

The registry lives in your own Supabase project, so I'll produce a migration file for you to run there:

- `registry.matter_stats` — one row per matter with party / entry / document / member counts.
- `registry.docket_entry_document_counts` — attachment count per docket entry.
- Indexes: `docket_entries(matter_id, entry_number)`, `documents(matter_id)`, `documents(docket_entry_id)`, `parties(matter_id)`, `counsel_appearances(matter_id)`, plus a GIN trigram index on `docket_entries.description` and `matters.case_name` for fast search.

The app is written so it works before those exist and gets faster the moment they do.

## Technical notes

- `src/lib/corpus.server.ts`: add `loadMatterPage`, `loadCorpusStats`, `loadLookups` (cached); rewrite `loadFilings` to page in SQL; retire `loadOverview` from the hot path.
- `src/lib/corpus.functions.ts` / `matters-corpus.ts`: new `getMatterPage` server fn and query options carrying filter state.
- `src/components/matters/MattersTable.tsx` + `src/routes/matters.index.tsx`: filters/sort/search become URL search params driving the server query; add pagination footer.
- No visual redesign in this pass — same look, same columns, just paged and fast.

## Verification

Time the Matters list and a large matter page before/after, and confirm the row counts fetched per view drop from tens of thousands to tens.
