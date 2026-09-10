// GET /api/public/office/jwks — public keys the Office engine service uses to
// verify the engine tokens this platform mints. Public by design (keys only);
// lives under /api/public because the global API middleware requires a session
// cookie everywhere else.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/office/jwks")({
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
