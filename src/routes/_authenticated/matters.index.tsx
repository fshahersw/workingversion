import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { MattersIndex } from "@/components/matters/MattersIndex";

// /matters is a real page: a browsable list of the firm's active matters.
export const Route = createFileRoute("/_authenticated/matters/")({
  ssr: false,
  component: MattersIndexPage,
  head: () => ({
    meta: [
      { title: "Matters | Seeger Weiss" },
      { name: "description", content: "The firm's active MDL litigation matters." },
    ],
  }),
});

function MattersIndexPage() {
  return (
    <AppShell>
      <MattersIndex />
    </AppShell>
  );
}
