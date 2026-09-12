// Server function-middleware that requires an authenticated Cognito session.
// Replaces `requireSupabaseAuth`. Reads the httpOnly session cookie (auto-sent
// with same-origin serverFn RPCs), verifies the Cognito id token, and attaches
// the user + userId to the server context. Server functions that previously used
// requireSupabaseAuth should switch to this.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const m = await import("@/lib/auth/cognito.server");
  const request = getRequest();
  const user = request ? await m.getUserFromRequest(request) : null;
  if (!user) throw new Error("Unauthorized");
  const { withInterpreterOwner } = await import("@/lib/agents/interpreter-context.server");
  return withInterpreterOwner(user.sub, () => next({ context: { user, userId: user.sub } }));
});

/** Middleware variant that also requires the `admin` role. */
export const requireAdmin = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const m = await import("@/lib/auth/cognito.server");
  const request = getRequest();
  const user = request ? await m.getUserFromRequest(request) : null;
  if (!user) throw new Error("Unauthorized");
  if (user.role !== "admin") throw new Error("Forbidden: admin role required");
  const { withInterpreterOwner } = await import("@/lib/agents/interpreter-context.server");
  return withInterpreterOwner(user.sub, () => next({ context: { user, userId: user.sub } }));
});
