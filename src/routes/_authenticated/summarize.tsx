import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/summarize")({
  ssr: false,
  beforeLoad: async () => {
    throw redirect({ to: "/docs", search: { tab: "search" }, replace: true });
  },
  component: () => null,
});
