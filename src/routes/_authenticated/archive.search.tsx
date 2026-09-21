import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  Caveats,
  CorpusHeader,
  ResultPanel,
  UnavailableNotice,
} from "@/components/archive/corpus-ui";
import { ExploreResults, SearchResults } from "@/components/archive/corpus-results";
import { getArchiveHealth } from "@/lib/archive/archive.functions";
import { corpusExplore, corpusSearch } from "@/lib/archive/corpus.functions";

// Search & Explore: one entry point across the whole Legal Archive. With a
// query it runs the Corpus Workbench ranked search; empty, it shows the
// archive's own explore view (collections and entry points). Results are the
// archive's records; open the domain pages (Courts, Federal, Jurisdictions) for
// the structured views.

export const Route = createFileRoute("/_authenticated/archive/search")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Search the Corpus — Seeger Weiss Platform" },
      {
        name: "description",
        content: "Ranked search across the Legal Archive and Corpus Workbench.",
      },
    ],
  }),
  component: SearchPage,
});

function SearchPage() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");

  const health = useQuery({
    queryKey: ["corpus", "health"],
    queryFn: () => getArchiveHealth(),
    staleTime: 30_000,
  });
  const reachable = health.data?.reachable ?? false;

  const query = useQuery({
    queryKey: ["corpus", "search", q],
    enabled: reachable,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: () => (q ? corpusSearch({ data: { q } }) : corpusExplore()),
  });

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <CorpusHeader
          title="Search the Corpus"
          description="Ranked search across the Legal Archive and its Corpus Workbench: case law, regulations, judges, MDLs, counties and agencies. Results are saved records with their provenance, not a claim of completeness."
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
          <div className="flex-1 space-y-5 px-6 py-6">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setQ(input.trim());
              }}
              className="flex h-11 max-w-2xl items-center gap-2 rounded-md border border-slate-300 px-3 focus-within:border-slate-400"
            >
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search the corpus (e.g. Daubert talc, 21 CFR 314, Judge Wolfson)…"
                className="h-full w-full bg-transparent text-[14px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
              />
              <button
                type="submit"
                className="h-8 rounded-md bg-slate-900 px-3 text-[12.5px] font-medium text-white transition hover:bg-slate-800"
              >
                Search
              </button>
            </form>
            {q && (
              <p className="text-[12px] text-slate-500">
                Ranked results for “{q}”. Open a domain page for the structured view.
              </p>
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
              emptyLabel={q ? "No matches in the archive." : "Enter a query to search the corpus."}
              render={(data) =>
                q ? <SearchResults value={data} /> : <ExploreResults value={data} />
              }
            />
            <Caveats />
          </div>
        )}
      </div>
    </AppShell>
  );
}
