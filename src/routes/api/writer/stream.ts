// POST /api/writer/stream — one model turn for the Writer's assistant loop.
// See @/lib/office/stream.server for the protocol; this route pins app=writer.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/writer/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOfficeStream } = await import("@/lib/office/stream.server");
        return handleOfficeStream(request, "writer");
      },
    },
  },
});
