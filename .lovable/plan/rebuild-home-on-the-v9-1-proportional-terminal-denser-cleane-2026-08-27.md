# Rebuild Home on the v9.1 proportional terminal — denser, cleaner

Match the uploaded `v9_1` mockup almost exactly, minus the toolbar button cluster in the second screenshot (Refresh / Saved 4 / Detailed / Compact — all removed), and broaden the intelligence collector so trending legal stories (AI sanctions, big settlements, sanctions orders) actually land in the feed.

## 1. Page frame

- Greeting header above the panel: uppercase date line, "Good morning/afternoon/evening.", one-line subhead, and a right-side live status dot with "Live · updated Xm ago" driven by the real last run time.
- Single fixed-height intelligence panel below it: rounded card, hairline border, soft shadow, nothing on the page scrolls except the results list and context rail.

## 2. Terminal chrome (cleaner than the mockup)

- Toolbar: search field only, full-width-ish, with the small metric line beside it (`N monitored`, `N priority`, `N new filings`) computed from live feed + corpus counts.
- No Refresh, no Saved views, no Detailed/Compact buttons. Density is fixed to the dense/detailed row layout.
- Section tabs exactly as the mockup: underline-on-active with the orange rule, light tab strip background, horizontal scroll on mobile.

## 3. Editorial showcase

- 1 large feature + 2 stacked side features, edge-to-edge imagery, gradient scrim, kicker / headline / standfirst.
- Static top three (no auto-rotation, no prev/pause/next controls, no progress bar) — keeps it calm and avoids layout churn.

## 4. Results list — maximum density

Each row is a 3-column grid: 132px thumbnail, content, right-hand tool column.

- Meta line: signal score chip, source, date, category, matter tag.
- Bold headline, one-line clamped summary.
- One-line "Practice analysis" strip (derived from the extracted description when it differs from the summary; hidden when there is nothing new to say — no invented text).
- Related-topic chips that push the term into the search filter.
- Right column: priority label (Critical / High / Monitor / Research, derived from signal score + category), open-in-reader arrow, open-source arrow.
- Feed header row: "Top developments", ranking explainer, result count.

## 5. Context rail (300px)

Three stacked modules matching the mockup:

- **Matter watch** — compact table of live corpus matters with heat indicator and recent activity.
- **Key dates / recent filings** — latest docket entries and orders from the corpus.
- **Alerts** — ingestion and monitoring alerts, clickable.

## 6. Reader pane

Clicking a headline swaps the workspace into the mockup's reader layout: list collapses to a narrow 374px column with small thumbs, and the reader shows hero image, title, standfirst, meta, fact strip, source cards, related cards, and links to the matter and the research agent. It is filled entirely with data we already store (image, summary, extracted description, topics, primary sources, matter link) — no fabricated article body.

## 7. Denser, more trend-aware collection

Extend the collector's query packs so the feed catches the stories you named:

- AI in litigation: sanctions for AI-fabricated citations, judicial AI orders, e-discovery AI rulings.
- Sanctions, contempt and discovery misconduct.
- Verdicts and punitive damage awards.
- New MDL petitions and JPML transfer orders.
- Plaintiff-firm/leadership and common-benefit news.
- State AG and consumer-protection actions.

Also raise per-run volume (more results per pack, more Firecrawl enrichments) so the list stays full, and keep dedupe/scoring/ingest exactly as they are.

## Technical notes

- All UI work is in `src/components/home/terminal/*` plus the Home route; the terminal is rebuilt around the v9.1 grid using existing semantic tokens (navy/orange/line) — no hardcoded hex outside `src/styles.css`.
- New tokens added to `src/styles.css` only if the mockup needs a shade we do not already have.
- `useTerminalData.ts` gains derived fields: priority, practice-analysis line, and the toolbar metrics; no new server round-trips.
- Reader pane is a new `ReaderPane.tsx`; `ContextRail.tsx` is restructured into the three modules and fed by the existing corpus signal loaders.
- Collector changes are confined to the `PACKS` list and the run caps in `src/lib/intel-collect.server.ts`; a run is triggered after the change so the new sections fill immediately.
