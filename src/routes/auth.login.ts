// GET /auth/login — start the Cognito authorization-code + PKCE flow.
// Sets short-lived httpOnly cookies (PKCE verifier, state, post-login redirect),
// then 302s to the Cognito hosted UI (which will front Entra once federated).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const m = await import("@/lib/auth/cognito.server");
        const { verifier, challenge } = m.newPkce();
        const state = m.newState();
        const url = new URL(request.url);
        const rawRedirect = url.searchParams.get("redirect") ?? "/";
        const redirectTo = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";

        const headers = new Headers();
        headers.append("Set-Cookie", m.serializeCookie(m.C_PKCE, verifier, 600));
        headers.append("Set-Cookie", m.serializeCookie(m.C_STATE, state, 600));
        headers.append("Set-Cookie", m.serializeCookie(m.C_REDIRECT, redirectTo, 600));
        headers.set("Location", m.authorizeUrl(state, challenge));
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
