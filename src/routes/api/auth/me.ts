// GET /api/auth/me — returns the current user from the session cookie, or 401.
// Used by the route gate and the useAuth hook (the session cookie is httpOnly,
// so the client learns auth state through this endpoint).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // apiAuthMiddleware has already resolved (and, if needed, refreshed)
        // the session and attaches any new cookie to this response.
        const m = await import("@/lib/auth/cognito.server");
        const session = await m.resolveSession(request);
        const user = session?.user ?? null;
        return new Response(JSON.stringify({ user }), {
          status: user ? 200 : 401,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
