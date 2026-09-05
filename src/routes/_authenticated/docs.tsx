import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { DocsWorkspace, type DocsTab } from "@/components/docs/DocsWorkspace";

type Search = {
  tab?: DocsTab;
};

export const Route = createFileRoute("/_authenticated/docs")({
  ssr: false,
  validateSearch: (raw: Record<string, unknown>): Search => ({
    tab:
      raw["tab"] === "deposition" || raw["tab"] === "depositions"
        ? "deposition"
        : raw["tab"] === "review"
          ? "review"
          : "search",
  }),
  head: () => ({
    meta: [
      { title: "Discovery — Seeger Weiss" },
      {
        name: "description",
        content:
          "Ask a working set or analyze deposition transcripts with page-cited answers.",
      },
      { property: "og:title", content: "Discovery — Seeger Weiss" },
      {
        property: "og:description",
        content:
          "Document intelligence workspace for litigation: search, summarize, and analyze transcripts and filings.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DocsPage,
});

function DocsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const tab = search.tab ?? "search";

  // Keep the tab in sync with the URL without full navigation flashes.
  useEffect(() => {
    if (!search.tab) {
      navigate({
        search: (prev) => ({ ...prev, tab: "search" }),
        replace: true,
      });
    }
  }, [search.tab, navigate]);

  return (
    <AppShell>
      <DocsWorkspace
        tab={tab}
        onTabChange={(next) =>
          navigate({
            search: (prev) => ({ ...prev, tab: next }),
            replace: true,
          })
        }
      />
    </AppShell>
  );
}
