// POST /api/public/ingest/batches/:id/commit — hand a validated bundle to the
// pipeline runner (store -> write -> extract -> embed -> verify).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ingest/batches/$id/commit")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { getBatch, json, requireIngestAuth, updateBatch } = await import("@/lib/ingest/store.server");
        const denied = requireIngestAuth(request);
        if (denied) return denied;

        const batch = await getBatch(params.id);
        if (!batch) return json({ error: "not_found", message: "unknown batch" }, 404);
        if (batch.status === "queued" || batch.status === "running") {
          return json({ batch_id: batch.batch_id, status: batch.status, message: "already committed" }, 200);
        }
        if (batch.status === "completed") {
          return json({ error: "already_completed", message: "this batch has already been ingested" }, 409);
        }
        if (batch.status !== "validated") {
          return json(
            { error: "not_validated", message: `batch is ${batch.status}; run /validate until it returns 200 first` },
            409,
          );
        }

        await updateBatch(batch.batch_id, { status: "queued", stage: "queued", error: null });
        return json({
          batch_id: batch.batch_id,
          status: "queued",
          counts: batch.counts,
          message: "queued for ingestion; poll the status endpoint",
        });
      },
    },
  },
});
