// POST /api/public/intel/run — trigger one Tavily/Firecrawl intelligence run.
// Auth: X-Cron-Token (database-held token used by the 4-hourly scheduled job)
// or X-Ingest-Key (same shared secret as the document ingest routes).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/intel/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { json, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const cronToken = request.headers.get("x-cron-token");
        let authorized = false;
        if (cronToken) {
          try {
            const { rpc } = await import("@/lib/ingest/store.server");
            authorized = (await rpc<boolean>("verify_intel_cron_token", { token: cronToken })) === true;
          } catch {
            authorized = false;
          }
        }
        if (!authorized) {
          const denied = requireIngestAuth(request);
          if (denied) return denied;
        }

        // Optional budget from the scheduled invoker: stay inside the ~300s
        // gateway cap. Absent/invalid body => an unbounded (manual) run.
        let opts: {
          deadlineMs?: number;
          maxScrapes?: number;
          analyzeCap?: number;
          reviewCap?: number;
        } = {};
        try {
          const body = (await request.json()) as {
            deadlineMs?: unknown;
            maxScrapes?: unknown;
            analyzeCap?: unknown;
            reviewCap?: unknown;
          };
          if (typeof body?.deadlineMs === "number")
            opts.deadlineMs = Math.min(Math.max(body.deadlineMs, 30_000), 850_000);
          if (typeof body?.maxScrapes === "number")
            opts.maxScrapes = Math.min(Math.max(Math.round(body.maxScrapes), 1), 110);
          if (typeof body?.analyzeCap === "number")
            opts.analyzeCap = Math.min(Math.max(Math.round(body.analyzeCap), 1), 140);
          if (typeof body?.reviewCap === "number")
            opts.reviewCap = Math.min(Math.max(Math.round(body.reviewCap), 1), 150);
        } catch {
          opts = {};
        }

        try {
          const { runIntelCollection } = await import("@/lib/intel-collect.server");
          const result = await runIntelCollection(opts);
          return json(result, result.ok ? 200 : 502);
        } catch (e) {
          return json(
            { ok: false, error: "run_failed", message: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      },
    },
  },
});
