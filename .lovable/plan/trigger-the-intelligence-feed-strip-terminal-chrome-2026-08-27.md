# Trigger the intelligence feed + strip terminal chrome

Both keys (`TAVILY_API_KEY`, `FIRECRAWL_API_KEY`) are now available to the app, so the home terminal can produce a real feed instead of waiting on the external host. Two pieces of work.

## 1. Make the feed actually run

Today nothing in the app calls Tavily or Firecrawl for the home page — it only accepts a feed posted by the external ETL host, and falls back to curated static headlines. Add an in-app collector so a run can be triggered now and on a schedule.

- New server-only collector that mirrors the `legal-intelligence` pipeline at a practical scale:
  - Tavily search packs for mass tort / MDL, courts & appeals, agencies (FDA, EPA, CPSC, FTC), research, settlements.
  - Title/URL de-duplication, authority + recency + practice-relevance scoring.
  - Firecrawl extraction for the top-ranked results only (bounded concurrency, hard cap per run) to keep runs fast and cheap; items that fail extraction still ship with Tavily summary + metadata.
  - Normalize to the existing feed contract and write through the existing `ingestFeed` path, so storage, run stats, dedupe and 90-day retention behave exactly as they already do.
- Trigger paths:
  - `POST /api/public/intel/run` guarded by the existing `X-Ingest-Key` — usable by cron or by the external host.
  - Owner-only manual run from the Pipeline page (same `fshaher@seegerweiss.com` allowlist), so a refresh never sits on a public button.
- Run once immediately after wiring so the terminal shows live signals instead of the static fallback.

Nothing about the document/docket ETL contract, corpus schema, or SSE research backend changes.

## 2. Clean, minimal terminal chrome

Remove the noisy header furniture from the home terminal:

- Drop the "Litigation Intelligence" title and the "Awaiting first run" / "Updated X ago" line.
- Drop the "Signals" and "Showing" counters.
- Keep: the filter input, the density toggle, the section tabs, the feature block, results and context rail.
- Keep a single small error indicator only when a run reports errors (icon + count, no label).
- Rebalance the toolbar so the search field leads the row and spacing stays even on mobile.

Empty-state copy stays, but "the intelligence run hasn't delivered a feed" becomes plain ("No headlines yet.").

## Technical notes

- Collector lives in `src/lib/intel-collect.server.ts`; keys read inside handlers only.
- Route `src/routes/api/public/intel/run.ts` reuses `requireIngestAuth` from `ingest/store.server`.
- Feed built with `intelFeedSchema` types, then `ingestFeed()` in `src/lib/intel.server.ts` — no new write path.
- UI edits confined to `src/components/home/terminal/IntelTerminal.tsx` (plus the empty-state string).
- Bounded run: cap Tavily queries and Firecrawl extractions per run, with a per-request timeout so a slow source cannot hang the route.
