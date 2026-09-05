import { useCallback, useEffect, useState } from "react";

// Cognito-backed auth state. The session lives in an httpOnly cookie, so the
// client reads its identity from /api/auth/me rather than holding a token.
export type AuthUser = {
  sub: string;
  email: string;
  name?: string;
  role: string;
  groups: string[];
};

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        return;
      }
      const data = (await res.json()) as { user: AuthUser | null };
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Start the Cognito hosted-UI sign-in (fronts Entra once federated).
  const signIn = useCallback((redirect?: string) => {
    const q = redirect ? `?redirect=${encodeURIComponent(redirect)}` : "";
    window.location.href = `/auth/login${q}`;
  }, []);

  const signOut = useCallback(() => {
    window.location.href = "/auth/logout";
  }, []);

  return { user, loading, signIn, signOut, refresh };
}
