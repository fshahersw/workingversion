import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  Caveats,
  CorpusHeader,
  ResultPanel,
  TabBar,
  UnavailableNotice,
} from "@/components/archive/corpus-ui";
import {
  CourtResults,
  JudgeResults,
  MdlResults,
  SearchResults,
} from "@/components/archive/corpus-results";
import { getArchiveHealth } from "@/lib/archive/archive.functions";
import { listDocuments, listJudges, listMdls, resolveCourt } from "@/lib/archive/corpus.functions";

// Courts & Litigation: courts, judges, MDLs and court documents from the Legal
// Archive. Mirrors the read-only Corpus page pattern (archive.sources.tsx):
// eyebrow header, tabs, a search box per tab, and the archive's own JSON
// rendered structurally. Every list is the archive's saved records, not a
// ranking or a claim of completeness.

export const Route = createFileRoute("/_authenticated/archive/courts")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Courts & Litigation — Seeger Weiss Platform" },
      {
        name: "description",
        content: "Courts, judges, MDLs and court documents in the Legal Archive.",
      },
    ],
  }),
  component: CourtsPage,
});

type Tab = "mdls" | "judges" | "courts" | "documents";
const TABS: { id: Tab; label: string }[] = [
  { id: "mdls", label: "MDLs" },
  { id: "judges", label: "Judges" },
  { id: "courts", label: "Courts" },
  { id: "documents", label: "Documents" },
];
const PLACEHOLDER: Record<Tab, string> = {
  mdls: "Filter MDLs (e.g. talc, Roundup, 2738)…",
  judges: "Find a judge by name…",
  courts: "Resolve a court (e.g. D.N.J., cand, Third Circuit)…",
  documents: "Search court documents…",
};

function CourtsPage() {
  const [tab, setTab] = useState<Tab>("mdls");
  const [q, setQ] = useState("");

  const health = useQuery({
    queryKey: ["corpus", "health"],
    queryFn: () => getArchiveHealth(),
    staleTime: 30_000,
  });
  const reachable = health.data?.reachable ?? false;

  const query = useQuery({
    queryKey: ["corpus", "courts", tab, q],
    enabled: reachable,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: () => {
      switch (tab) {
        case "courts":
          return resolveCourt({ data: { q } });
        case "judges":
          return listJudges({ data: { q } });
        case "documents":
          return listDocuments({ data: { q } });
        case "mdls":
        default:
          return listMdls({ data: { q } });
      }
    },
  });

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <CorpusHeader
          title="Courts & Litigation"
          description="Courts, judges, multidistrict litigation and court documents saved in the Legal Archive. Counts are counts of saved records, never a ranking or a measure of importance."
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
              <label className="flex h-10 max-w-xl items-center gap-2 rounded-md border border-slate-300 px-3">
                <Search className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={PLACEHOLDER[tab]}
                  className="h-full w-full bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
                />
              </label>
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
                emptyLabel={
                  q
                    ? "No matching records in the archive."
                    : "Type to search, or browse the saved records."
                }
                render={(data) => {
                  switch (tab) {
                    case "judges":
                      return <JudgeResults value={data} />;
                    case "courts":
                      return <CourtResults value={data} />;
                    case "documents":
                      return <SearchResults value={data} />;
                    case "mdls":
                    default:
                      return <MdlResults value={data} />;
                  }
                }}
              />
              <Caveats />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
