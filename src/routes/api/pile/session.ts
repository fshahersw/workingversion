import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createPileSession } = await import("@/lib/pile/session.server");
        let body: { matterLabel?: string; instructions?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        try {
          const session = createPileSession(body);
          return Response.json(session);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not create pile session" },
            { status: 500 },
          );
        }
      },
    },
  },
});
