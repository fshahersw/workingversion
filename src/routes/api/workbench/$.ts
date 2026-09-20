import { createFileRoute } from "@tanstack/react-router";

// Browser-facing proxy to the Corpus Workbench JSON API (ranked search,
// record versions, compare, citations, health). Same rules as /api/archive:
// Cognito session, allow-listed GET paths only, upstream JSON verbatim.
// Evidence handoff (the workbench's one POST) is a platform server function,
// not a proxied call.

export const Route = createFileRoute("/api/workbench/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        const { archiveEnabled, workbenchGet, ArchiveError } = await import("@/lib/archive/client.server");
        if (!archiveEnabled()) return Response.json({ error: "legal archive not configured" }, { status: 503 });

        const splat = String((params as { _splat?: string })._splat ?? "").replace(/^\/+/, "");
        const path = `/${splat}`;
        const query = new URL(request.url).searchParams;
        try {
          const result = await workbenchGet(path, query, { timeoutMs: 25_000, signal: request.signal });
          return Response.json(result.data, { headers: { "Cache-Control": "private, no-store" } });
        } catch (error) {
          if (error instanceof ArchiveError) {
            const status = error.status === 403 ? 404 : error.status >= 500 ? 502 : error.status;
            return Response.json({ error: error.status === 403 ? "not found" : error.message }, { status });
          }
          return Response.json({ error: error instanceof Error ? error.message : "workbench request failed" }, { status: 502 });
        }
      },
    },
  },
});
