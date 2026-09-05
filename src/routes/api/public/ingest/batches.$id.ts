// GET /api/public/ingest/batches/:id — status + rejects for one bundle.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ingest/batches/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { getBatch, json, listRejects, requireIngestAuth } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;

        const batch = await getBatch(params.id);
        if (!batch) return json({ error: "not_found", message: "unknown batch" }, 404);
        return json({ ...batch, rejects: await listRejects(batch.batch_id, 100) });
      },
    },
  },
});
