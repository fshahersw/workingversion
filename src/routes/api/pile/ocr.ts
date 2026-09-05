import { createFileRoute } from "@tanstack/react-router";

import { HttpStatusError } from "@/lib/pile/async";

export const Route = createFileRoute("/api/pile/ocr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Two accepted shapes: raw JPEG bytes (preferred — ~33% smaller on the
        // wire than base64 JSON) or the legacy { imageBase64 } body.
        const body: { imageBase64?: string } = {};
        const ct = request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          try {
            Object.assign(body, (await request.json()) as { imageBase64?: string });
          } catch {
            /* empty */
          }
        } else {
          const buf = new Uint8Array(await request.arrayBuffer());
          if (buf.byteLength) {
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) {
              bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            }
            body.imageBase64 = btoa(bin);
          }
        }
        if (!body.imageBase64) {
          return Response.json({ error: "image bytes required" }, { status: 400 });
        }
        try {
          const { ocrPageImage } = await import("@/lib/pile/vl-ocr.server");
          const { withRetry } = await import("@/lib/pile/async");
          const text = await withRetry(() => ocrPageImage(body.imageBase64!), {
            tries: 3,
            baseMs: 500,
            retry429: false,
          });
          return Response.json({ text });
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
