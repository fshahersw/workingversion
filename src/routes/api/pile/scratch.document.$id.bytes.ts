import { createFileRoute } from "@tanstack/react-router";

/**
 * Append one raw slice of a PDF. The body is the bytes themselves (not JSON),
 * so nothing is base64-inflated over the wire; the slice is encoded once here
 * on the way into the bytea column.
 */
export const Route = createFileRoute("/api/pile/scratch/document/$id/bytes")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { appendScratchBytes } = await import("@/lib/pile/scratch.server");
        try {
          const buf = new Uint8Array(await request.arrayBuffer());
          if (!buf.byteLength) return Response.json({ error: "empty slice" }, { status: 400 });
          let binary = "";
          const step = 0x8000;
          for (let i = 0; i < buf.length; i += step) {
            binary += String.fromCharCode(...buf.subarray(i, i + step));
          }
          const total = await appendScratchBytes(params.id, btoa(binary));
          return Response.json({ ok: true, total });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Upload slice failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
