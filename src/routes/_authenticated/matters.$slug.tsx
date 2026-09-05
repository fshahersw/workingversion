import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { MatterWorkspace } from "@/components/matters/MatterWorkspace";

type Search = {
  tab?: "ledger" | "documents";
  q?: string;
  types?: string[];
  withPdf?: boolean;
  docket?: "main" | "jpml";
  sort?: "entry-desc" | "entry-asc";
  entry?: string;
  page?: number;
};

export const Route = createFileRoute("/_authenticated/matters/$slug")({
  ssr: false,
  validateSearch: (raw: Record<string, unknown>): Search => ({
    tab: raw["tab"] === "documents" ? "documents" : "ledger",
    q: typeof raw["q"] === "string" && raw["q"] ? raw["q"] : undefined,
    types: Array.isArray(raw["types"]) ? (raw["types"] as string[]) : undefined,
    withPdf: raw["withPdf"] === true || raw["withPdf"] === "true" ? true : undefined,
    docket: raw["docket"] === "main" || raw["docket"] === "jpml" ? raw["docket"] : undefined,
    sort: raw["sort"] === "entry-asc" ? "entry-asc" : raw["sort"] === "entry-desc" ? "entry-desc" : undefined,
    entry: typeof raw["entry"] === "string" && raw["entry"] ? raw["entry"] : undefined,
    page: typeof raw["page"] === "number" ? raw["page"] : undefined,
  }),
  component: MatterWorkspacePage,
  head: ({ params }) => ({
    meta: [
      { title: `${params.slug.split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ")} | Seeger Weiss` },
      { name: "description", content: "Matter workspace — docket ledger, documents, parties, and counsel." },
    ],
  }),
});

function MatterWorkspacePage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <AppShell>
      <MatterWorkspace
        slug={slug}
        search={{
          tab: search.tab ?? "ledger",
          q: search.q,
          types: search.types,
          withPdf: search.withPdf,
          docket: search.docket,
          sort: search.sort,
          entry: search.entry,
          page: search.page,
        }}
        onSearch={(patch) =>
          navigate({
            search: (prev) => {
              const next = { ...prev, ...patch };
              for (const k of Object.keys(next) as (keyof Search)[]) {
                if (next[k] === undefined) delete next[k];
              }
              return next;
            },
            replace: true,
          })
        }
      />
    </AppShell>
  );
}
