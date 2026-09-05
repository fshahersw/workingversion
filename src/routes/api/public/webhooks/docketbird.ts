// POST /api/public/webhooks/docketbird?token=<DOCKET_WEBHOOK_SECRET>
//
// DocketBird new-filing webhook receiver. Same contract as the CourtListener
// receiver: authenticate, deduplicate, persist the raw payload, return fast.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/docketbird")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireWebhookAuth, recordEvent, findWatchByDbDocket, pick } = await import(
          "@/lib/docketwatch.server"
        );

        const denied = requireWebhookAuth(request);
        if (denied) return denied;

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        const dbDocketId = pick(payload, [
          "docket_id",
          "docket.id",
          "data.docket_id",
          "case_id",
        ]);

        const idem = String(
          pick(payload, ["event_id", "id", "notification_id", "data.event_id"]) ??
            `db:${dbDocketId ?? "unknown"}:${Date.now()}`,
        );

        try {
          const watch = dbDocketId ? await findWatchByDbDocket(String(dbDocketId)) : null;
          const res = await recordEvent({
            provider: "docketbird",
            providerEventId: idem,
            watch,
            dbDocketId: dbDocketId ? String(dbDocketId) : null,
            payload,
          });
          return Response.json({ ok: true, ...res, matched: Boolean(watch) });
        } catch (err) {
          console.error("docketbird webhook failed", err);
          return Response.json({ error: "store_failed" }, { status: 500 });
        }
      },
    },
  },
});
