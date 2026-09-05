// GET /api/auth/me — returns the current user from the session cookie, or 401.
// Used by the route gate and the useAuth hook (the session cookie is httpOnly,
// so the client learns auth state through this endpoint).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const m = await import("@/lib/auth/cognito.server");
        const user = await m.getUserFromRequest(request);
        return new Response(JSON.stringify({ user }), {
          status: user ? 200 : 401,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
