import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";

type MeResponse = {
  user: { sub: string; email: string; name?: string; role: string; groups: string[] } | null;
};

/** How often a long-lived page re-checks (and silently refreshes) its session. */
const SESSION_CHECK_MS = 10 * 60_000;

/**
 * Keeps a long-lived page signed in. The server refreshes the id-token cookie
 * from the refresh cookie on any authenticated call; this ping makes sure that
 * happens before the hour is up even when the user is only reading. When the
 * session is truly gone (refresh token expired or revoked), the user is sent
 * to sign in with a return path instead of watching panels fail.
 */
function SessionKeeper() {
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          const back = `${window.location.pathname}${window.location.search}`;
          window.location.href = `/auth/login?redirect=${encodeURIComponent(back)}`;
        }
      } catch {
        /* offline or transient: try again on the next tick */
      }
    };
    const timer = window.setInterval(() => void check(), SESSION_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    const { user } = (await res.json()) as MeResponse;
    if (!user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    return { user };
  },
  component: () => (
    <>
      <SessionKeeper />
      <Outlet />
    </>
  ),
});
