// POST /api/public/matters/sync — pull new docket entries and PDFs for the
// followed hub dockets from DocketBird into the matters corpus (Aurora + S3).
// Auth: X-Ingest-Key (same secret as the other ingest/cron routes). Invoked on
// a schedule by the runtime stack's sync invoker; each call does bounded work.
//
// Body (optional JSON): { "docketId": "njd-2:2024-md-03113" } to sync one
// docket, or { "maxDockets": 3, "maxDownloads": 40 } to tune a scheduled run.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/matters/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { json, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;
        const { syncConfigured, syncDocket, syncFollowedDockets } =
          await import("@/lib/matters/docket-sync.server");
        if (!syncConfigured()) {
          return json(
            {
              ok: false,
              error: "sync_disabled",
              message: "DocketBird or the corpus database is not configured",
            },
            503,
          );
        }
        let body: Record<string, unknown> = {};
        try {
          const text = await request.text();
          if (text.trim()) body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
        };
        // Stay well inside the 300 s gateway timeout.
        const deadlineMs = clamp(body["deadlineMs"], 30_000, 250_000, 240_000);
        const maxDownloads = clamp(body["maxDownloads"], 1, 200, 40);
        try {
          if (typeof body["docketId"] === "string" && body["docketId"]) {
            const result = await syncDocket(body["docketId"], {
              deadlineMs,
              maxDownloads,
              signal: request.signal,
            });
            return json({ ok: !result.error, result });
          }
          const maxDockets = clamp(body["maxDockets"], 1, 20, 3);
          const out = await syncFollowedDockets({
            deadlineMs,
            maxDownloads,
            maxDockets,
            signal: request.signal,
          });
          return json({ ok: true, ...out });
        } catch (e) {
          console.error("[matters-sync] failed", e instanceof Error ? e.message : e);
          return json(
            {
              ok: false,
              error: "sync_failed",
              message: e instanceof Error ? e.message : String(e),
            },
            500,
          );
        }
      },
    },
  },
});
