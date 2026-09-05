// POST /api/public/ingest/batches — open a bundle, get presigned upload URLs.
// Auth: X-Ingest-Key header (shared secret). Never trusts filenames.
import { createFileRoute } from "@tanstack/react-router";

import { CONTRACT_VERSION, incomingKey, manifest as manifestSchema } from "@/lib/ingest/schema";

export const Route = createFileRoute("/api/public/ingest/batches")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createBatch, json, presign, putText, requireIngestAuth } = await import(
          "@/lib/ingest/store.server"
        );
        const denied = requireIngestAuth(request);
        if (denied) return denied;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid_json", message: "request body must be JSON" }, 400);
        }

        const parsed = manifestSchema.safeParse(body);
        if (!parsed.success) {
          return json(
            {
              error: "invalid_manifest",
              contract_version: CONTRACT_VERSION,
              issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
            422,
          );
        }
        const m = parsed.data;

        let batch;
        try {
          batch = await createBatch(m);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "duplicate_idempotency_key") {
            return json({ error: "duplicate_batch", message: `idempotency_key already used for ${m.matter.slug}` }, 409);
          }
          return json({ error: "batch_create_failed", message: msg }, 500);
        }

        const slug = m.matter.slug;
        const id = batch.batch_id;
        await putText(incomingKey(slug, id, "manifest.json"), JSON.stringify(m), "application/json");

        const uploads = {
          docket_csv: await presign(incomingKey(slug, id, "docket.csv"), "PUT"),
          parties_csv: await presign(incomingKey(slug, id, "parties.csv"), "PUT"),
          files: await Promise.all(
            m.files.map(async (f) => ({
              file_name: f.file_name,
              url: await presign(incomingKey(slug, id, f.file_name), "PUT"),
            })),
          ),
        };

        return json(
          {
            batch_id: id,
            status: batch.status,
            contract_version: CONTRACT_VERSION,
            expires_in: 3600,
            uploads,
            next: {
              validate: `/api/public/ingest/batches/${id}/validate`,
              commit: `/api/public/ingest/batches/${id}/commit`,
              status: `/api/public/ingest/batches/${id}`,
            },
          },
          201,
        );
      },
    },
  },
});
