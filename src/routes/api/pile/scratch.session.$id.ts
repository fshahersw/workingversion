import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/scratch/session/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { scratchProgress, touchScratchSession } = await import("@/lib/pile/scratch.server");
        try {
          const progress = await scratchProgress(params.id);
          void touchScratchSession(params.id);
          return Response.json(progress);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Workspace not found" },
            { status: 404 },
          );
        }
      },
      DELETE: async ({ params }) => {
        const { deleteScratchSession } = await import("@/lib/pile/scratch.server");
        try {
          await deleteScratchSession(params.id);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not delete workspace" },
            { status: 500 },
          );
        }
      },
    },
  },
});
