import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "@/components/app-shell";
import { UsCoverageMap } from "@/components/archive/UsCoverageMap";
import {
  CorpusHeader,
  ResultPanel,
  TabBar,
  UnavailableNotice,
} from "@/components/archive/corpus-ui";
import {
  CountyLitigationResults,
  CountyResults,
  StateCoverageResults,
} from "@/components/archive/corpus-results";
import { getArchiveHealth } from "@/lib/archive/archive.functions";
import {
  corpusExplore,
  countyLitigation,
  listCounties,
  stateCoverage,
} from "@/lib/archive/corpus.functions";
import { stateSelection, type StateSelection } from "@/lib/archive/corpus-shapes";

// States & Counties: state-level coverage (with a US map), the counties saved
// per state, and county-level litigation records. Selecting a state on the map
// or typing its code drives the Counties and Litigation tabs. Counts are counts
// of saved records; known gaps (GA/NC statutes, some blocked county sources) are
// the archive's own and shown on the coverage tab.

export const Route = createFileRoute("/_authenticated/archive/jurisdictions")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "States & Counties — Seeger Weiss Platform" },
      {
        name: "description",
        content: "State-level coverage, counties and county litigation in the Legal Archive.",
      },
    ],
  }),
  component: JurisdictionsPage,
});

type Tab = "coverage" | "counties" | "litigation";
const TABS: { id: Tab; label: string }[] = [
  { id: "coverage", label: "Coverage map" },
  { id: "counties", label: "Counties" },
  { id: "litigation", label: "Litigation" },
];

function JurisdictionsPage() {
  const [tab, setTab] = useState<Tab>("coverage");
  const [state, setState] = useState<string>("");

  const health = useQuery({
    queryKey: ["corpus", "health"],
    queryFn: () => getArchiveHealth(),
    staleTime: 30_000,
  });
  const reachable = health.data?.reachable ?? false;

  const coverage = useQuery({
    queryKey: ["corpus", "state-coverage"],
    queryFn: () => corpusExplore(),
    enabled: reachable,
    staleTime: 300_000,
  });
  const selectedState = stateSelection(state);

  const stateDetail = useQuery({
    queryKey: ["corpus", "state-coverage-detail", selectedState?.code],
    queryFn: () =>
      stateCoverage({
        data: {
          state: selectedState!.code,
          stateName: selectedState!.name,
        },
      }),
    enabled: reachable && tab === "coverage" && selectedState !== null,
    staleTime: 300_000,
  });

  const detail = useQuery({
    queryKey: ["corpus", "jurisdiction", tab, state],
    enabled: reachable && tab !== "coverage" && selectedState !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: () =>
      tab === "litigation"
        ? countyLitigation({
            data: { state: selectedState!.code, stateName: selectedState!.name },
          })
        : listCounties({
            data: { state: selectedState!.code, stateName: selectedState!.name },
          }),
  });

  const selectState = (selection: StateSelection) => {
    setState(selection.code);
    if (tab === "coverage") setTab("counties");
  };

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <CorpusHeader
          title="States & Counties"
          description="State-level coverage across the corpus, the counties saved per state, and county litigation records. Counts are counts of saved records, not completeness; the archive's known gaps are listed on the coverage tab."
        >
          {state && (
            <span className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-[12.5px] text-slate-700">
              Selected: <strong className="font-semibold">{state}</strong>
              <button
                type="button"
                onClick={() => setState("")}
                className="text-slate-400 hover:text-slate-700"
              >
                clear
              </button>
            </span>
          )}
        </CorpusHeader>

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
              {tab === "coverage" ? (
                <>
                  <UsCoverageMap
                    coverage={coverage.data?.data ?? null}
                    loading={coverage.isLoading}
                    selected={state}
                    onSelect={selectState}
                  />
                  <section>
                    <h2 className="text-[13px] font-semibold text-slate-900">State coverage</h2>
                    <p className="mt-0.5 text-[12px] text-slate-500">
                      Global counts come from the archive&apos;s jurisdiction inventory. Select a
                      state to load its detailed coverage and counties.
                    </p>
                    <div className="mt-3">
                      <ResultPanel
                        result={selectedState ? stateDetail.data : coverage.data}
                        loading={selectedState ? stateDetail.isLoading : coverage.isLoading}
                        error={
                          selectedState
                            ? stateDetail.error instanceof Error
                              ? stateDetail.error.message
                              : null
                            : coverage.error instanceof Error
                              ? coverage.error.message
                              : null
                        }
                        emptyLabel={
                          selectedState
                            ? `No coverage detail reported for ${selectedState.name}.`
                            : "No coverage reported."
                        }
                        render={(data) => <StateCoverageResults value={data} />}
                      />
                    </div>
                  </section>
                </>
              ) : (
                <>
                  <label className="flex h-10 max-w-xs items-center gap-2 rounded-md border border-slate-300 px-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      State
                    </span>
                    <input
                      value={state}
                      onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                      placeholder="NJ"
                      className="h-full w-full bg-transparent text-[13px] uppercase text-slate-800 placeholder:text-slate-400 focus:outline-none"
                    />
                  </label>
                  <ResultPanel
                    result={detail.data}
                    loading={detail.isLoading || (detail.isFetching && !detail.data)}
                    error={
                      detail.error instanceof Error
                        ? detail.error.message
                        : detail.error
                          ? String(detail.error)
                          : null
                    }
                    emptyLabel={
                      state
                        ? `No saved ${tab === "litigation" ? "litigation" : "counties"} for ${state}.`
                        : "Pick a state (type its 2-letter code or use the map)."
                    }
                    render={(data) =>
                      tab === "litigation" ? (
                        <CountyLitigationResults value={data} />
                      ) : (
                        <CountyResults value={data} />
                      )
                    }
                  />
                </>
              )}{" "}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
