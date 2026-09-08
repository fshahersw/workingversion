import { createStart, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Gate every /api/* file route on a valid Cognito session, EXCEPT /api/public/*
// (webhooks + ingest self-authenticate with their own shared-secret headers).
// File routes are API endpoints reachable independently of any page, so auth has
// to live here in request middleware — not in a page route guard, and not in the
// function-middleware pipeline (`requireAuth` is `type: "function"` and only
// guards serverFn RPCs, never file-based server routes). Returns a JSON 401
// rather than throwing, so `errorMiddleware` does not turn it into a 500 page.
const apiAuthMiddleware = createMiddleware().server(async ({ next }) => {
  const request = getRequest();
  if (request) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/public/")) {
      const { resolveSession } = await import("@/lib/auth/cognito.server");
      const session = await resolveSession(request);
      if (!session) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (session.setCookies.length) {
        // The id token was silently refreshed: hand the new cookie back with
        // whatever the route returns (including streamed responses).
        const result = await next();
        const headers = new Headers(result.response.headers);
        for (const cookie of session.setCookies) headers.append("Set-Cookie", cookie);
        return new Response(result.response.body, {
          status: result.response.status,
          statusText: result.response.statusText,
          headers,
        });
      }
    }
  }
  return next();
});

export const startInstance = createStart(() => ({
  // errorMiddleware first (outermost) so it still catches anything downstream;
  // apiAuthMiddleware then gates /api/* before any route handler runs.
  requestMiddleware: [errorMiddleware, apiAuthMiddleware],
  // Cognito session rides in an httpOnly cookie that is auto-sent with same-origin
  // serverFn RPCs, so no client bearer-attacher is needed. Server functions that
  // require auth use `requireAuth` from "@/lib/auth/require-auth".
  functionMiddleware: [],
}));
