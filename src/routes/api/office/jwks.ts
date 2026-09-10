// GET /api/office/jwks — public keys the Office engine service uses to verify
// the engine tokens this platform mints. Public by design (keys only).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/office/jwks")({
  server: {
    handlers: {
      GET: async () => {
        const { engineJwks } = await import("@/lib/office/engine-token.server");
        return Response.json(await engineJwks(), {
          headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
        });
      },
    },
  },
});
