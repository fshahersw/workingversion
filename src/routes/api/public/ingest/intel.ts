// POST /api/public/ingest/intel — receive the Tavily/Firecrawl feed.
// Auth: X-Ingest-Key header (same shared secret as the document ingest routes).
// Idempotent: upserts on canonical URL, records a run, prunes stale items.
import { createFileRoute } from "@tanstack/react-router";

import { INTEL_CONTRACT_VERSION, intelFeedSchema } from "@/lib/intel-schema";

export const Route = createFileRoute("/api/public/ingest/intel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { json, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid_json", message: "request body must be JSON" }, 400);
        }

        const parsed = intelFeedSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            {
              error: "invalid_feed",
              contract_version: INTEL_CONTRACT_VERSION,
              issues: parsed.error.issues
                .slice(0, 40)
                .map((i) => ({ path: i.path.join("."), message: i.message })),
            },
            422,
          );
        }

        try {
          const { ingestFeed } = await import("@/lib/intel.server");
          const result = await ingestFeed(parsed.data);
          return json({ ok: true, contract_version: INTEL_CONTRACT_VERSION, ...result });
        } catch (e) {
          return json(
            { error: "ingest_failed", message: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      },

      GET: async ({ request }) => {
        const { json, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;
        const { loadIntelStatus } = await import("@/lib/intel.server");
        return json({ contract_version: INTEL_CONTRACT_VERSION, ...(await loadIntelStatus()) });
      },
    },
  },
});
