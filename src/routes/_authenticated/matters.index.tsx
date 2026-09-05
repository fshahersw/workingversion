import { createFileRoute, redirect } from "@tanstack/react-router";

import { getMatters } from "@/lib/workspace.functions";

// /matters redirects straight into the first matter's workspace; the MDL
// selector in the sidebar is the real navigation surface.
export const Route = createFileRoute("/_authenticated/matters/")({
  ssr: false,
  beforeLoad: async () => {
    const matters = await getMatters();
    if (matters.length > 0) {
      throw redirect({ to: "/matters/$slug", params: { slug: matters[0].slug }, replace: true });
    }
  },
  component: () => null,
});
