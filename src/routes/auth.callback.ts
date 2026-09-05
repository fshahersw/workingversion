// GET /auth/callback — Cognito redirects here with ?code&state.
// Verifies state (CSRF), exchanges the code (with the PKCE verifier) for tokens,
// sets the httpOnly session cookies, clears the transient cookies, and 302s to
// the original destination.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const m = await import("@/lib/auth/cognito.server");
        const url = new URL(request.url);
        const err = url.searchParams.get("error");
        if (err) {
          const desc = url.searchParams.get("error_description") ?? "";
          return new Response(`Sign-in error: ${err} ${desc}`, { status: 400 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const cookies = m.parseCookies(request.headers.get("cookie"));
        if (!code || !state || state !== cookies[m.C_STATE]) {
          return new Response("Invalid sign-in callback (state mismatch).", { status: 400 });
        }
        const verifier = cookies[m.C_PKCE];
        if (!verifier) return new Response("Missing PKCE verifier; restart sign-in.", { status: 400 });

        let tokens;
        try {
          tokens = await m.exchangeCode(code, verifier);
        } catch (e) {
          return new Response(
            `Token exchange failed: ${e instanceof Error ? e.message : String(e)}`,
            { status: 502 },
          );
        }

        const rawRedirect = cookies[m.C_REDIRECT] ?? "/";
        const dest = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";

        const headers = new Headers();
        headers.append("Set-Cookie", m.serializeCookie(m.C_ID, tokens.id_token, tokens.expires_in));
        if (tokens.refresh_token) {
          headers.append("Set-Cookie", m.serializeCookie(m.C_REFRESH, tokens.refresh_token, 30 * 24 * 3600));
        }
        headers.append("Set-Cookie", m.clearCookie(m.C_PKCE));
        headers.append("Set-Cookie", m.clearCookie(m.C_STATE));
        headers.append("Set-Cookie", m.clearCookie(m.C_REDIRECT));
        headers.set("Location", dest);
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
