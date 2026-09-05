# Denser home terminal: AI briefings, no filing thumbnails, wider source fan-out

Three parts: kill images where they add nothing, generate real AI analysis in the backend run, and widen discovery well past the current 13 query packs.

## 1. Filings & Orders (and all corpus tabs) go text-only

Corpus rows never have an image, but they still render the thumbnail tile (a navy placeholder block) and get truncated to one line. Change:

- Results rows switch to two layouts: **media rows** (news/courts/agencies/research/settlements) keep the thumbnail; **document rows** (MDL, Filings & Orders, Alerts) drop the image column entirely and use the reclaimed width for content.
- Document rows show: entry number / type badge, matter, court, filed date, full description (wrapped, up to 3 lines instead of truncated), document + PDF counts, and the AI bullets below.
- Remove the `truncate` one-line clamps on detail and context strips so long text wraps; the list itself is the scroll surface.

## 2. Real scrollability and denser formatting

- The results list gets its own scroll container with a sticky column header row (Source · Signal · Filed · Priority) so long feeds scroll under a fixed header instead of pushing the panel.
- Sticky day dividers ("Today", "Yesterday", "Aug 24") between rows.
- Row body becomes: headline → one-line lead → 2–4 AI bullets → related-topic chips. Bullets are the density the current single "Context" line can't carry.
- Reader pane gets the full briefing: what happened, why it matters, exposure/practice impact, primary sources, related coverage — all scrollable.
- Feature block only uses stories that actually have an editorial image; anything else falls back to a text-forward card.

## 3. AI analysis generated in the backend run

Every intelligence run (already the ingest path) adds an analysis pass before writing:

- Batched calls through the Lovable AI gateway (Gemini Flash, cheap and fast) turn each story's title + summary + extracted text into: a 1-sentence lead, 2–4 tight bullets, a "why it matters for mass tort practice" line, and normalized topic tags.
- The same pass runs over the newest corpus docket entries, turning raw docket text ("MOTION for extension of time...") into a plain-language line plus bullets, cached so the page never calls a model on render.
- Results are stored, not computed on view: new nullable columns on the intel items table and a small cached analysis table keyed by docket entry id. Front end just reads them.

## 4. Wide fan-out discovery

Today: 13 packs, Law360 excluded, LinkedIn blocked, 4 stories per outlet.

- Expand to ~30 query packs: mass tort/MDL, JPML, bellwethers, Daubert/preemption, sanctions & AI misconduct, discovery/spoliation, verdicts, settlements & funds, litigation finance, insurance coverage, class certification, PFAS/environmental, pharma & device safety, FDA/EPA/CPSC/FTC/DOJ/state AG, securities & consumer class actions, appellate/SCOTUS, judicial appointments, plaintiff-firm and leadership moves, legal-industry/AI-in-practice, science & epidemiology.
- Bring **Law360 and Bloomberg Law back in** as ranked sources (they are top legal outlets) but keep a per-outlet cap so no single publisher can own the page; add explicit source targeting for Reuters Legal, Bloomberg Law, Law.com/ALM, Law360, Legal Newsline, Courthouse News, Above the Law, Reuters, AP, JD Supra, National Law Review, plus court and agency primary sources.
- LinkedIn: surface practitioner/firm posts as a distinct low-weight "Commentary" category (Tavily discovery only, no scraping, no image), so it adds signal without polluting the news column.
- Raise retained candidates and enrichment budget so a run yields a few hundred scored stories rather than ~100.

## Technical notes

- Collector: `src/lib/intel-collect.server.ts` (packs, source targeting, caps, analysis pass). Analysis helper in a new `src/lib/intel-analyze.server.ts` using `LOVABLE_API_KEY` read inside the handler, bounded concurrency, and graceful degradation — a failed analysis leaves the story with its plain summary rather than dropping it.
- Schema: additive migration in `supabase/corpus/intel.sql` for `analysis_lead`, `analysis_bullets text[]`, `analysis_impact` on `corpus_intel_items`, plus `corpus_docket_analysis` (entry id, bullets, generated_at) with service-role-only grants. `intel_ingest` extended to accept the new fields; existing rows stay valid.
- Types: `IntelItem`/`CorpusSignal` in `src/lib/intel-types.ts` gain `bullets: string[]` and `impact: string | null`; readers in `src/lib/intel.server.ts` map them.
- UI: `ResultsPane.tsx` (row variants, sticky header, day dividers), `IntelTerminal.tsx` (scroll container), `ReaderPane.tsx` (full briefing), `FeatureShowcase.tsx` (image-only features).
- Run cadence unchanged: `POST /api/public/intel/run` stays the trigger for the every-few-hours schedule; the analysis pass runs inside it with a hard per-run cap so a run can't hang.
