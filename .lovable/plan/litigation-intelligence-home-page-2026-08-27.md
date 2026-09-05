# Litigation Intelligence home page

Rebuild Home as a fixed-height intelligence terminal (v8.1 shell) with a static
editorial feature block at the top (v5.1 treatment, no auto-rotation), fed by the
Tavily/Firecrawl pipeline running on the external ETL host and by our own corpus.

## Layout

```text
+--------------------------------------------------------------+
| Thursday, August 27   Good morning, Firas.        Live · 4m   |
+--------------------------------------------------------------+
| search ........  42 monitored  12 priority  7 new  [Detailed] |
| News & Analysis | MDL | Filings & Orders | Courts | Agencies  |
|   | Research | Settlements | Alerts                           |
+--------------------------------------------------------------+
| [ FEATURE (large, image) ] [ feature B ]                      |
|                            [ feature C ]                      |
+---------------------------------------------+----------------+
| results pane (scrolls)                      | context rail   |
|  row: signal · type · source · time · title |  selected item |
|  row: ...                                   |  primary source|
+---------------------------------------------+----------------+
```

- Whole panel is one fixed-height surface; only the results pane scrolls. No page scroll.
- Density toggle (Detailed / Compact) changes row height and hides snippets.
- Selecting a row fills the right context rail: full snippet, source + favicon,
  detected primary source link (the actual order/complaint Firecrawl chased),
  rights/paywall badge, related topics, and "Ask the research agent about this"
  which deep-links to /research with the item prefilled.
- Tabs read from different origins:
  - News & Analysis, Courts, Agencies, Research, Settlements → Tavily/Firecrawl feed
  - MDL / Mass Tort, Filings & Orders, Alerts → our corpus (recent docket entries,
    newly ingested documents, matters with activity, ingestion warnings)
- Empty categories render an honest empty state with last-refresh time, never a blank pane.
- Mobile: rail collapses under the results pane, feature block becomes a single card,
  tabs become a horizontally scrolling strip.

## Data pipeline

The uploaded `legal-intelligence-retrieval` package runs unchanged on the external
ETL host (same box as the ETL workers), on a cron. Its `out/latest-feed.json` is
POSTed to a new endpoint; the app never calls Tavily or Firecrawl at request time.

- New table `corpus.intel_items`: `id` (sha of canonical url), `category`, `title`,
  `url`, `canonical_url`, `source_domain`, `favicon_url`, `image_url`, `snippet`,
  `signal_score`, `published_at`, `fetched_at`, `rights`, `paywall`, `primary_sources`
  (jsonb), `related_topics` (text[]), `pack_id`, `run_id`. Unique on `canonical_url`.
  Plus `corpus.intel_runs` (run_id, started/finished, counts, errors) so the header's
  "Live · refreshed N ago" and "Sources healthy" are real.
- New endpoint `POST /api/public/ingest/intel` — same `X-Ingest-Key` auth as the
  existing ingest routes, Zod-validated feed schema, upsert on `canonical_url`
  (newer `fetched_at` wins), and a run record. Idempotent; safe to re-post.
- Retention: keep 90 days, prune older rows on each run.
- Reads go through a new `getIntelFeed` server function (category, search, limit),
  and `getCorpusSignals` for the corpus-backed tabs.

## Feed quality

The pipeline already rejects topic/author pages, dedups by title similarity, scores
recency and source authority, and chases primary sources. Two additions on our side:

- Suppress items whose `signal_score` is below a floor unless the tab is empty.
- Boost any item whose text matches a matter we actually hold in the corpus, and
  tag those rows with the matter name so they link straight to `/matters/$slug`.

## Technical notes

- New files: `src/components/home/terminal/` (`IntelTerminal`, `TerminalToolbar`,
  `SectionTabs`, `FeatureShowcase`, `ResultsPane`, `ResultRow`, `ContextRail`),
  `src/lib/intel.functions.ts`, `src/lib/intel.server.ts`, `src/lib/intel-schema.ts`,
  `src/routes/api/public/ingest/intel.ts`, `supabase/corpus/intel.sql`.
- `HomeDashboard.tsx` is replaced by the terminal; `news-static.ts` retired once the
  first real run lands (kept as fallback until then so Home is never empty).
- Colors come from existing tokens in `src/styles.css`; the mockups' hardcoded hexes
  map onto the current navy/slate palette. New tokens only for the signal/severity
  chips (critical / watch / routine), added to `@theme inline`.
- Uses the existing `_authenticated` route with `ssr: false`, matching sibling routes.
- Home gets its own `head()` metadata.

## What I need from you to go live

The `TAVILY_API_KEY` and `FIRECRAWL_API_KEY` live on the ETL host, not in this app.
I'll ship the endpoint, schema and UI plus a seeded sample run so you can see it
working; you point the host's cron at `https://swtesting.dev/api/public/ingest/intel`
with the existing ingest key and the feed goes live.
