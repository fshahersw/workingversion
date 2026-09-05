import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

type MeResponse = {
  user: { sub: string; email: string; name?: string; role: string; groups: string[] } | null;
};

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
  component: () => <Outlet />,
});
