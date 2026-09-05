import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getPileSession } = await import("@/lib/pile/session.server");
        const session = getPileSession(params.id);
        if (!session) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json(session);
      },
    },
  },
});
