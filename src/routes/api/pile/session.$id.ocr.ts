import { createFileRoute } from "@tanstack/react-router";

import { HttpStatusError } from "@/lib/pile/async";

export const Route = createFileRoute("/api/pile/session/$id/ocr")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { ocrPilePage } = await import("@/lib/pile/session.server");
        let body: { fileName?: string; page?: number; imageBase64?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        if (!body.fileName || !body.page || !body.imageBase64) {
          return Response.json({ error: "fileName, page, imageBase64 required" }, { status: 400 });
        }
        try {
          const { session, text } = await ocrPilePage(params.id, body.fileName, body.page, body.imageBase64);
          return Response.json({ ...session, text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "ocr failed";
          const status =
            err instanceof HttpStatusError
              ? err.status
              : /HTTP 429/.test(msg)
                ? 429
                : /HTTP 5\d\d/.test(msg)
                  ? 502
                  : 400;
          const headers: Record<string, string> = {};
          if (status === 429) {
            const sec =
              err instanceof HttpStatusError && err.retryAfterMs
                ? Math.ceil(err.retryAfterMs / 1000)
                : 1;
            headers["Retry-After"] = String(Math.max(1, sec));
          }
          return Response.json({ error: msg }, { status, headers });
        }
      },
    },
  },
});
