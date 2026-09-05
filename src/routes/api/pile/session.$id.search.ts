import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session/$id/search")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { hybridSearchPile } = await import("@/lib/pile/session.server");
        const { ASK_CANDIDATES } = await import("@/lib/pile/limits");
        let body: { query?: string; k?: number } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const query = (body.query ?? "").trim();
        if (!query) return Response.json({ error: "query required" }, { status: 400 });
        try {
          const hits = await hybridSearchPile(params.id, query, Math.min(body.k ?? 12, ASK_CANDIDATES));
          return Response.json({ hits });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "search failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
