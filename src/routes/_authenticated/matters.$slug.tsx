import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { MatterWorkspace, type WorkspaceSearch } from "@/components/matters/MatterWorkspace";
import { DOCKET_SCOPES, type DocketScope, type LedgerSort } from "@/lib/workspace-types";

const SORTS: LedgerSort[] = ["date-desc", "date-asc", "entry-desc", "entry-asc"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const date = (v: unknown): string | undefined =>
  typeof v === "string" && DATE_RE.test(v) ? v : undefined;
const flag = (v: unknown): true | undefined => (v === true || v === "true" ? true : undefined);

export const Route = createFileRoute("/_authenticated/matters/$slug")({
  ssr: false,
  validateSearch: (raw: Record<string, unknown>): WorkspaceSearch => ({
    view: raw["view"] === "documents" ? "documents" : undefined,
    q: str(raw["q"]),
    types: Array.isArray(raw["types"])
      ? (raw["types"] as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined,
    scope: (DOCKET_SCOPES as string[]).includes(String(raw["scope"]))
      ? (raw["scope"] as DocketScope)
      : undefined,
    docket: str(raw["docket"]),
    from: date(raw["from"]),
    to: date(raw["to"]),
    pdf: flag(raw["pdf"]),
    hideSealed: flag(raw["hideSealed"]),
    sort: (SORTS as string[]).includes(String(raw["sort"]))
      ? (raw["sort"] as LedgerSort)
      : undefined,
    entry: str(raw["entry"]),
    doc: str(raw["doc"]),
    page: typeof raw["page"] === "number" && raw["page"] > 1 ? raw["page"] : undefined,
  }),
  component: MatterWorkspacePage,
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.slug
          .split("-")
          .map((w) => w[0]?.toUpperCase() + w.slice(1))
          .join(" ")} | Seeger Weiss`,
      },
      { name: "description", content: "Matter workspace: dockets, filings, and documents." },
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
        search={search}
        onSearch={(patch) =>
          navigate({
            search: (prev) => {
              const next: Record<string, unknown> = { ...prev, ...patch };
              for (const k of Object.keys(next)) {
                if (next[k] === undefined) delete next[k];
              }
              return next as WorkspaceSearch;
            },
            replace: true,
          })
        }
      />
    </AppShell>
  );
}
