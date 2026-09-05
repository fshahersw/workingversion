# Refresh the home intelligence feed and keep it fresh automatically

## What I found

- The feed's last collection run finished **28 Aug 00:40 UTC — about 11 hours ago**. Everything on Home is from that run.
- That run was healthy: 298 stories discovered, 153 kept, 105 pages scraped, 138 editorial images, 132 AI briefings.
- Images are effectively solved: of 423 stored stories, only **1** lacks a real editorial image.
- The real gap is analysis coverage: **177 of 423 stories have no AI briefing** (bullets/lead/impact). These are older rows collected before the analysis pass existed, and they still show in the feed as bare headlines.
- There is **no scheduler**. `POST /api/public/intel/run` exists and works, but nothing calls it, and the owner-only manual trigger lost its button when the Pipeline page was removed. Every refresh so far has been run by hand.

## Plan

1. **Run a fresh collection now** so Home shows today's headlines, images and briefings, and report the run stats (discovered / kept / images / analyses / any source errors).

2. **Backfill the 177 un-analyzed stories.** A one-off pass over rows with a null `analysis_lead`, batched through the existing analysis helper, so every row in the feed carries a lead, bullets and practice impact — no more bare headlines mixed in with rich ones.

3. **Automate the refresh every 4 hours.** A scheduled job posts to `/api/public/intel/run` with the existing ingest key, so the page is never more than a few hours stale. Runs are idempotent (upsert on canonical URL) and already prune past 90 days.

4. **No manual trigger anywhere in the UI.** Refreshes happen only on the schedule — no buttons, no owner-only control.

5. **Quiet fix along the way:** the login page currently logs a hydration mismatch on load; corrected while I'm in there.

## Out of scope

No changes to the terminal layout, tabs, row density or reader pane — this is freshness and content depth only.

## Technical notes

- Collection: `runIntelCollection()` in `src/lib/intel-collect.server.ts`, written through `ingestFeed()` in `src/lib/intel.server.ts`; no schema change.
- Backfill: a one-off script using `src/lib/intel-analyze.server.ts` with bounded concurrency, writing `analysis_lead`, `analysis_bullets`, `analysis_impact` on `corpus_intel_items`.
- Schedule: cron against the stable preview/production URL with `X-Ingest-Key`, hitting the existing public route — no new endpoint.
- No UI trigger is added; `runIntelRefresh` in `src/lib/pipeline.functions.ts` stays unexposed.
