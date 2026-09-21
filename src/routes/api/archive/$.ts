import { createFileRoute } from "@tanstack/react-router";

// Browser-facing proxy to the Legal Archive JSON API. Cognito session required
// (apiAuthMiddleware gates every /api/* route; the principal is re-checked
// here). Only paths named in src/lib/archive/policy.ts are forwarded, GET
// only, and the upstream JSON is returned verbatim so provenance and
// qualification fields reach the UI untouched. The gateway's app key never
// leaves the server.
//
//   GET /api/archive/api/documents?q=…        -> archive /api/documents
//   GET /api/archive/supplement-files/<l>/<f> -> archive /supplement-files/<l>/<f>

export const Route = createFileRoute("/api/archive/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        const { archiveEnabled, archiveGet, ArchiveError } = await import("@/lib/archive/client.server");
        if (!archiveEnabled()) return Response.json({ error: "legal archive not configured" }, { status: 503 });

        const splat = String((params as { _splat?: string })._splat ?? "").replace(/^\/+/, "");
        const path = `/${splat}`;
        const query = new URL(request.url).searchParams;
        try {
          const result = await archiveGet(path, query, { timeoutMs: 25_000, signal: request.signal });
          return Response.json(result.data, {
            headers: { "Cache-Control": "private, no-store", "X-Archive-Layer-Closed": result.closed ? "1" : "0" },
          });
        } catch (error) {
          if (error instanceof ArchiveError) {
            const status = error.status === 403 ? 404 : error.status >= 500 ? 502 : error.status;
            return Response.json({ error: error.status === 403 ? "not found" : error.message }, { status });
          }
          return Response.json({ error: error instanceof Error ? error.message : "archive request failed" }, { status: 502 });
        }
      },
    },
  },
});
