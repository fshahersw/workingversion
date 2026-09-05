import { createFileRoute } from "@tanstack/react-router";

/** Register a document in the workspace before its bytes are streamed up. */
export const Route = createFileRoute("/api/pile/scratch/session/$id/document")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { registerScratchDocument, UPLOAD_SLICE_BYTES } = await import(
          "@/lib/pile/scratch.server"
        );
        let body: { name?: string; sha256?: string; byteSize?: number } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const name = (body.name ?? "").trim();
        const sha256 = (body.sha256 ?? "").trim();
        if (!name || !/^[0-9a-f]{64}$/i.test(sha256)) {
          return Response.json({ error: "name and sha256 required" }, { status: 400 });
        }
        try {
          const result = await registerScratchDocument({
            sessionId: params.id,
            name,
            sha256,
            byteSize: Math.max(0, Number(body.byteSize ?? 0)),
          });
          return Response.json({ ...result, sliceBytes: UPLOAD_SLICE_BYTES });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not register document" },
            { status: 500 },
          );
        }
      },
    },
  },
});
