import { createFileRoute } from "@tanstack/react-router";

// KB hybrid search for the Working Set: embed the query (Titan) -> pgvector+BM25
// RRF -> Bedrock rerank -> top-K passages, scoped to the verified Cognito
// principal by FORCE RLS. Gated by apiAuthMiddleware; principal derived here.

const SURFACES = new Set(["workingset", "deposition", "review"]);

type Body = {
  workspaceId?: string;
  surface?: string;
  query?: string;
  topK?: number;
  docIds?: string[];
};

export const Route = createFileRoute("/api/kb/search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        const { kbConfigured } = await import("@/lib/kb/aurora.server");
        if (!kbConfigured()) {
          return Response.json({ error: "KB is not configured" }, { status: 503 });
        }

        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }

        const workspaceId = String(body.workspaceId ?? "").trim();
        const surface = String(body.surface ?? "").trim();
        const query = String(body.query ?? "").trim();
        if (!workspaceId || !SURFACES.has(surface) || !query) {
          return Response.json(
            { error: "workspaceId, valid surface, and query are required" },
            { status: 400 },
          );
        }
        const topK = Math.max(1, Math.min(Number(body.topK) || 12, 50));
        const docIds = Array.isArray(body.docIds)
          ? body.docIds.map(String).filter(Boolean).slice(0, 200)
          : undefined;

        try {
          const { searchKb } = await import("@/lib/kb/search.server");
          const hits = await searchKb(user.sub, {
            workspaceId,
            surface: surface as "workingset" | "deposition" | "review",
            query,
            topK,
            ...(docIds && docIds.length ? { docIds } : {}),
            signal: request.signal,
          });
          return Response.json({ hits });
        } catch (e) {
          const message = e instanceof Error ? e.message : "search failed";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
