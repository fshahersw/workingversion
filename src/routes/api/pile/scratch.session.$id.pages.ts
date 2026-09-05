import { createFileRoute } from "@tanstack/react-router";

/** Incremental pull of converted pages: ?after=<pageId>&limit=500 */
export const Route = createFileRoute("/api/pile/scratch/session/$id/pages")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { fetchScratchPages } = await import("@/lib/pile/scratch.server");
        const url = new URL(request.url);
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        const limit = Number(url.searchParams.get("limit") ?? 500) || 500;
        try {
          const pages = await fetchScratchPages(params.id, after, limit);
          return Response.json({
            pages,
            cursor: pages.length ? pages[pages.length - 1]!.pageId : after,
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not read pages" },
            { status: 400 },
          );
        }
      },
    },
  },
});
