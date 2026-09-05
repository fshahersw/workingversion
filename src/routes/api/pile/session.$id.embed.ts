import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session/$id/embed")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const { embedPile } = await import("@/lib/pile/session.server");
        try {
          const n = await embedPile(params.id, request.signal);
          return Response.json({ embedded: n });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "embed failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
