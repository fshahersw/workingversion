import { createFileRoute, redirect } from "@tanstack/react-router";

// The research agent page moved to /research. Keep the old URL working.
export const Route = createFileRoute("/_authenticated/conversations")({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/research" });
  },
});
