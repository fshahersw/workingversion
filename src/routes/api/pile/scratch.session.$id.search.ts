import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/scratch/session/$id/search")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { searchScratch, rerankScratchHits, touchScratchSession } = await import(
          "@/lib/pile/scratch.server"
        );
        let body: { query?: string; k?: number; rerank?: boolean } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const query = (body.query ?? "").trim();
        if (!query) return Response.json({ error: "query required" }, { status: 400 });
        try {
          const k = Math.min(Math.max(body.k ?? 12, 1), 50);
          const fused = await searchScratch(params.id, query, Math.max(k * 2, 20));
          const hits = body.rerank === false ? fused.slice(0, k) : await rerankScratchHits(query, fused, k);
          void touchScratchSession(params.id);
          return Response.json({ hits });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Search failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
