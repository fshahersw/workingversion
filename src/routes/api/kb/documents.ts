import { createFileRoute } from "@tanstack/react-router";

// List the caller's saved KB documents for a surface (RLS-scoped). Read-only
// visibility for the Working Set "saved documents" view. Gated by
// apiAuthMiddleware; principal derived here.

const SURFACES = new Set(["workingset", "deposition", "review"]);
const DEFAULT_WORKSPACE = "00000000-0000-0000-0000-000000000001";

export const Route = createFileRoute("/api/kb/documents")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        const { kbConfigured } = await import("@/lib/kb/aurora.server");
        if (!kbConfigured()) {
          return Response.json({ error: "KB is not configured" }, { status: 503 });
        }

        const url = new URL(request.url);
        const workspaceId = (url.searchParams.get("workspaceId") || DEFAULT_WORKSPACE).trim();
        const surface = (url.searchParams.get("surface") || "workingset").trim();
        if (!SURFACES.has(surface)) {
          return Response.json({ error: "invalid surface" }, { status: 400 });
        }

        try {
          const { listDocuments } = await import("@/lib/kb/aurora.server");
          const documents = await listDocuments(
            user.sub,
            workspaceId,
            surface as "workingset" | "deposition" | "review",
          );
          return Response.json({ documents });
        } catch (e) {
          const message = e instanceof Error ? e.message : "list failed";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
