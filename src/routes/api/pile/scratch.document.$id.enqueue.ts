import { createFileRoute } from "@tanstack/react-router";

/**
 * Fan a fully uploaded document out into worker jobs. `ocrPages` are the
 * 1-indexed pages with no usable text layer — those spans take the OCR queue.
 */
export const Route = createFileRoute("/api/pile/scratch/document/$id/enqueue")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { enqueueScratchDocument } = await import("@/lib/pile/scratch.server");
        let body: { pageCount?: number; ocrPages?: number[] } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const pageCount = Math.max(0, Number(body.pageCount ?? 0));
        if (!pageCount) return Response.json({ error: "pageCount required" }, { status: 400 });
        try {
          const jobs = await enqueueScratchDocument({
            documentId: params.id,
            pageCount,
            ocrPages: (body.ocrPages ?? []).filter((n) => Number.isInteger(n) && n > 0),
          });
          return Response.json({ ok: true, jobs });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not queue document" },
            { status: 500 },
          );
        }
      },
    },
  },
});
