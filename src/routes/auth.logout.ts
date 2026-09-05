// GET /auth/logout — clear the session cookies and 302 to the Cognito logout
// endpoint (which ends the Cognito session and returns to the app).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: async () => {
        const m = await import("@/lib/auth/cognito.server");
        const headers = new Headers();
        headers.append("Set-Cookie", m.clearCookie(m.C_ID));
        headers.append("Set-Cookie", m.clearCookie(m.C_REFRESH));
        headers.set("Location", m.logoutUrl());
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
