import { createFileRoute } from "@tanstack/react-router";

// Synchronous KB ingest for the Working Set MVP: the browser sends the pages it
// already extracted; the server chunks + embeds (Titan) + persists to Aurora,
// scoped to the verified Cognito principal. Gated by apiAuthMiddleware; we also
// derive the principal here. Bulk/scanned docs get the async BDA lane later.

const SURFACES = new Set(["workingset", "deposition", "review"]);
const MAX_PAGES = 2000;
const MAX_TOTAL_CHARS = 3_000_000; // ~sync-safe; larger => async lane

type Body = {
  workspaceId?: string;
  surface?: string;
  fileName?: string;
  mime?: string;
  sha256?: string;
  byteSize?: number;
  pages?: { page?: number; text?: string }[];
};

export const Route = createFileRoute("/api/kb/ingest")({
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
        const fileName = String(body.fileName ?? "").trim();
        if (!workspaceId || !SURFACES.has(surface) || !fileName) {
          return Response.json(
            { error: "workspaceId, valid surface, and fileName are required" },
            { status: 400 },
          );
        }

        const pages = (body.pages ?? [])
          .map((p) => ({ page: Number(p.page), text: String(p.text ?? "") }))
          .filter((p) => Number.isFinite(p.page) && p.page > 0 && p.text.trim());
        if (!pages.length) {
          return Response.json({ error: "no non-empty pages" }, { status: 400 });
        }
        if (pages.length > MAX_PAGES) {
          return Response.json(
            { error: `too many pages for the sync path (max ${MAX_PAGES}); use the async lane` },
            { status: 413 },
          );
        }
        const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
        if (totalChars > MAX_TOTAL_CHARS) {
          return Response.json(
            { error: "document too large for the sync path; use the async lane" },
            { status: 413 },
          );
        }

        try {
          const { ingestPages } = await import("@/lib/kb/ingest.server");
          const result = await ingestPages(user.sub, {
            workspaceId,
            surface: surface as "workingset" | "deposition" | "review",
            fileName,
            ...(body.mime ? { mime: String(body.mime) } : {}),
            ...(body.sha256 ? { sha256: String(body.sha256) } : {}),
            ...(Number.isFinite(body.byteSize) ? { byteSize: Number(body.byteSize) } : {}),
            pages,
          });
          return Response.json(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : "ingest failed";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
