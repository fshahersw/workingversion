import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/rerank")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          query?: string;
          k?: number;
          structure?: unknown;
          hits?: {
            fileId?: string;
            fileName?: string;
            page?: number;
            score?: number;
            snippet?: string;
            ocr?: boolean;
            garbled?: boolean;
          }[];
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const query = (body.query ?? "").trim();
        const hits = (body.hits ?? [])
          .filter((h) => h.fileId && h.page)
          .map((h) => ({
            fileId: String(h.fileId),
            fileName: String(h.fileName ?? ""),
            page: Number(h.page),
            score: Number(h.score) || 0,
            snippet: String(h.snippet ?? ""),
            ocr: !!h.ocr,
            garbled: !!h.garbled,
          }));
        const k = Math.max(4, Math.min(Number(body.k) || 16, hits.length || 16));
        if (!query || !hits.length) {
          return Response.json({ hits });
        }
        try {
          const { hybridRerankHits } = await import("@/lib/pile/hybrid-rerank.server");
          const ranked = await hybridRerankHits(
            query,
            hits,
            k,
            (body.structure as never) ?? null,
            request.signal,
          );
          return Response.json({ hits: ranked });
        } catch {
          return Response.json({ hits: hits.slice(0, k) });
        }
      },
    },
  },
});
