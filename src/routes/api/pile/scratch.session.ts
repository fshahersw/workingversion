import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/scratch/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createScratchSession, scratchConfigured } = await import(
          "@/lib/pile/scratch.server"
        );
        if (!scratchConfigured()) {
          return Response.json({ error: "Corpus backend is not configured" }, { status: 503 });
        }
        let body: { label?: string; instructions?: string; ownerEmail?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        try {
          const session = await createScratchSession({
            label: body.label ?? null,
            instructions: body.instructions ?? null,
            ownerEmail: body.ownerEmail ?? null,
          });
          return Response.json(session);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not create workspace" },
            { status: 500 },
          );
        }
      },
    },
  },
});
