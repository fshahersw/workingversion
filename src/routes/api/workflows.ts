import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/workflows")({
  server: {
    handlers: {
      GET: async ({ request }) => (await import("@/lib/workflows/api.server")).workflowApi(request),
      POST: async ({ request }) =>
        (await import("@/lib/workflows/api.server")).workflowApi(request),
    },
  },
});
