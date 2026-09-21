import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  CorpusHeader,
  ResultPanel,
  TabBar,
  UnavailableNotice,
} from "@/components/archive/corpus-ui";
import { AgencyResults, CfrResults, LawOutlineResults } from "@/components/archive/corpus-results";
import { getArchiveHealth } from "@/lib/archive/archive.functions";
import {
  agencyHub,
  agencySearch,
  lawOutline,
  regSearch,
  regTitles,
} from "@/lib/archive/corpus.functions";
import { useDebouncedValue } from "@/lib/archive/use-debounced-value";

// Federal Law & Agencies: the Code of Federal Regulations (CFR), the US Code
// outline, and the federal agency hub, all from the Legal Archive. Regulations
// and agencies accept a search; the US Code tab shows the saved outline. Every
// answer is a publisher snapshot; check the edition at the official source.

export const Route = createFileRoute("/_authenticated/archive/federal")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Federal Law & Agencies — Seeger Weiss Platform" },
      {
        name: "description",
        content: "CFR, the US Code outline and the federal agency hub in the Legal Archive.",
      },
    ],
  }),
  component: FederalPage,
});

type Tab = "regulations" | "uscode" | "agencies";
const TABS: { id: Tab; label: string }[] = [
  { id: "regulations", label: "Regulations (CFR)" },
  { id: "uscode", label: "US Code" },
  { id: "agencies", label: "Agencies" },
];

function FederalPage() {
  const [tab, setTab] = useState<Tab>("regulations");
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q);
  const searchable = tab !== "uscode";

  const health = useQuery({
    queryKey: ["corpus", "health"],
    queryFn: () => getArchiveHealth(),
    staleTime: 30_000,
  });
  const reachable = health.data?.reachable ?? false;

  const query = useQuery({
    queryKey: ["corpus", "federal", tab, searchable ? debouncedQ : ""],
    enabled: reachable,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: () => {
      switch (tab) {
        case "uscode":
          return lawOutline();
        case "agencies":
          return debouncedQ ? agencySearch({ data: { q: debouncedQ } }) : agencyHub();
        case "regulations":
        default:
          return debouncedQ ? regSearch({ data: { q: debouncedQ } }) : regTitles();
      }
    },
  });

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <CorpusHeader
          title="Federal Law & Agencies"
          description="The Code of Federal Regulations, the US Code outline and the federal agency hub as saved in the Legal Archive. Saved wording is a snapshot as of its capture date; confirm the current edition and status at the official source."
        />

        {health.data && !health.data.configured ? (
          <div className="px-6 py-6">
            <UnavailableNotice configured={false} />
          </div>
        ) : health.data && !health.data.reachable ? (
          <div className="px-6 py-6">
            <UnavailableNotice configured error={health.data.error} />
          </div>
        ) : (
          <>
            <TabBar tabs={TABS} active={tab} onChange={setTab} />
            <div className="flex-1 space-y-5 px-6 py-6">
              {searchable && (
                <label className="flex h-10 max-w-xl items-center gap-2 rounded-md border border-slate-300 px-3">
                  <Search className="h-4 w-4 shrink-0 text-slate-400" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={
                      tab === "regulations"
                        ? "Search the CFR, or browse titles below…"
                        : "Search agencies, or browse the hub below…"
                    }
                    className="h-full w-full bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
                  />
                </label>
              )}
              <ResultPanel
                result={query.data}
                loading={query.isLoading || (query.isFetching && !query.data)}
                error={
                  query.error instanceof Error
                    ? query.error.message
                    : query.error
                      ? String(query.error)
                      : null
                }
                emptyLabel="Nothing saved here yet."
                render={(data) => {
                  switch (tab) {
                    case "uscode":
                      return <LawOutlineResults value={data} />;
                    case "agencies":
                      return <AgencyResults value={data} />;
                    case "regulations":
                    default:
                      return <CfrResults value={data} />;
                  }
                }}
              />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
