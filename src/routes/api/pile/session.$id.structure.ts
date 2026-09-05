import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session/$id/structure")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const { structurePile } = await import("@/lib/pile/session.server");
        try {
          const structure = await structurePile(params.id);
          return Response.json(structure);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "structure failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
