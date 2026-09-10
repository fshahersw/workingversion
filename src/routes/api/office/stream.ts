// POST /api/office/stream — one model turn for an Office editor's assistant
// loop. Body carries `app` (writer | sheets) which selects the tool policy.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/office/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOfficeStream } = await import("@/lib/office/stream.server");
        return handleOfficeStream(request);
      },
    },
  },
});
