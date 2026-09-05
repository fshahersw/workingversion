import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session/$id/ingest")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { ingestPile } = await import("@/lib/pile/session.server");
        let body: { files?: { name: string; pages: { page: number; text: string }[] }[] } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return Response.json({ error: "files required" }, { status: 400 });
        try {
          const session = ingestPile(params.id, files);
          return Response.json(session);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "ingest failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
