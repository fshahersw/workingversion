import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/discovery")({
  ssr: false,
  validateSearch: (raw: Record<string, unknown>) => ({
    tab: raw["tab"] === "depositions" || raw["tab"] === "deposition" ? "deposition" : "search",
  }),
  beforeLoad: async ({ search }) => {
    throw redirect({
      to: "/docs",
      search: { tab: search.tab === "deposition" ? "deposition" : "search" },
      replace: true,
    });
  },
  component: () => null,
});
