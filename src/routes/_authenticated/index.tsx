import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { IntelTerminal } from "@/components/home/terminal/IntelTerminal";

export const Route = createFileRoute("/_authenticated/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Litigation Intelligence — Seeger Weiss LLP" },
      {
        name: "description",
        content:
          "Monitored mass tort news, MDL dockets, filings, agency actions, and settlement signals in one litigation intelligence terminal.",
      },
      { property: "og:title", content: "Litigation Intelligence — Seeger Weiss LLP" },
      {
        property: "og:description",
        content:
          "Monitored mass tort news, MDL dockets, filings, agency actions, and settlement signals in one terminal.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <AppShell showHeaderLogo>
      <IntelTerminal />
    </AppShell>
  );
}
