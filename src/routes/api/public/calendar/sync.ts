// POST /api/public/calendar/sync — pull DocketBird AutoCalendar into corpus.
// Auth: X-Ingest-Key (same secret as the other ingest/cron routes).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/calendar/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { json, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;
        try {
          const { syncCorpusCalendar } = await import("@/lib/calendar.server");
          const result = await syncCorpusCalendar(180);
          return json({ ok: true, ...result });
        } catch (e) {
          return json(
            { ok: false, error: "sync_failed", message: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      },
    },
  },
});
