// POST /api/public/webhooks/courtlistener?token=<DOCKET_WEBHOOK_SECRET>
//
// CourtListener docket-alert webhook receiver. Authenticates, deduplicates on
// the provider's Idempotency-Key, stores the raw payload, and returns 200 fast
// — CourtListener disables endpoints that are slow or error.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/courtlistener")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireWebhookAuth, recordEvent, findWatchByClDocket, pick, asNumber } =
          await import("@/lib/docketwatch.server");

        const denied = requireWebhookAuth(request);
        if (denied) return denied;

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        const clDocketId = asNumber(
          pick(payload, [
            "payload.results.0.docket",
            "payload.results.0.docket_id",
            "results.0.docket",
            "docket",
            "docket_id",
          ]),
        );

        const idem =
          request.headers.get("idempotency-key") ??
          String(
            pick(payload, ["webhook.event_id", "idempotency_key", "id"]) ??
              `cl:${clDocketId ?? "unknown"}:${Date.now()}`,
          );

        try {
          const watch = clDocketId ? await findWatchByClDocket(clDocketId) : null;
          const res = await recordEvent({
            provider: "courtlistener",
            providerEventId: idem,
            watch,
            clDocketId,
            payload,
          });
          return Response.json({ ok: true, ...res, matched: Boolean(watch) });
        } catch (err) {
          console.error("courtlistener webhook failed", err);
          // 500 tells CourtListener to retry; the dedupe key makes that safe.
          return Response.json({ error: "store_failed" }, { status: 500 });
        }
      },
    },
  },
});
