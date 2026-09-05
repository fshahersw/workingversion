import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { SECTIONS, type SectionId } from "@/lib/intel-types";
import { ContextRail } from "./ContextRail";
import { FeatureShowcase } from "./FeatureShowcase";
import { ReaderPane } from "./ReaderPane";
import { ResultsPane } from "./ResultsPane";
import {
  daysSince,
  relTime,
  useIntelStatus,
  useRailData,
  useTerminalRows,
  type TerminalRow,
} from "./useTerminalData";

const EMPTY: Record<SectionId, string> = {
  news: "No headlines yet.",
  mdl: "No matters in the corpus yet.",
  filings: "No docket entries ingested yet.",
  courts: "No court or appellate signals in the latest run.",
  agencies: "No agency or enforcement signals in the latest run.",
  research: "No research signals in the latest run.",
  settlements: "No settlement signals in the latest run.",
  commentary: "No practitioner commentary in the latest run.",
  alerts: "No ingestion alerts — every run is healthy.",
};


export function IntelTerminal() {
  const [section, setSection] = useState<SectionId>("news");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { rows, isLoading, error, origin } = useTerminalRows(section, search);
  const { data: status } = useIntelStatus();
  const { matters, filings, alerts } = useRailData();

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const readerOpen = selected !== null;
  const showFeature = origin === "intel" && !search && !readerOpen;
  const listRows = showFeature ? rows.slice(3) : rows;

  const newFilings = useMemo(
    () => filings.filter((f) => (daysSince(f.timestamp) ?? 999) <= 7).length,
    [filings],
  );
  const priorityCount = useMemo(
    () => rows.filter((r) => r.priority === "critical" || r.priority === "high").length,
    [rows],
  );

  const onSelect = (row: TerminalRow) => setSelectedId((cur) => (cur === row.id ? null : row.id));
  const onTopic = (topic: string) => {
    setSearch(topic);
    setSelectedId(null);
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 bg-muted/40 px-3 pb-4 pt-2.5 sm:px-5">
      {/* Page header */}
      <header className="flex shrink-0 items-start justify-between gap-4 px-0.5">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.19em] text-muted-foreground">
            {today}
          </p>
        </div>
        <div className="mt-1 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-[7px] w-[7px] rounded-full bg-emerald-500" />
          <span className="hidden sm:inline">Live · </span>
          {status?.lastRunAt ? `updated ${relTime(status.lastRunAt)} ago` : "standing by"}
        </div>
      </header>

      {/* Intelligence panel */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_7px_22px_rgba(15,41,64,0.045)]">
        {/* Toolbar */}
        <div className="flex h-[44px] shrink-0 items-center gap-3 border-b border-border/70 px-2.5">
          <div className="relative min-w-0 flex-1 sm:max-w-[430px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search matters, parties, courts, dockets, filings or research"
              className="h-[31px] w-full rounded border border-border bg-muted/40 pl-8 pr-7 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand-blue/50 focus:bg-card"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="hidden items-center gap-3.5 text-[11px] text-muted-foreground md:flex">
            <span>
              <b className="font-semibold text-brand-navy">{matters.length}</b> monitored
            </span>
            <span>
              <b className="font-semibold text-brand-navy">{priorityCount}</b> priority
            </span>
            <span>
              <b className="font-semibold text-brand-navy">{newFilings}</b> new filings
            </span>
          </div>

        </div>

        {/* Section tabs */}
        <nav className="flex h-[38px] shrink-0 items-end overflow-x-auto border-b border-border/70 bg-muted/40 px-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSection(s.id);
                setSelectedId(null);
              }}
              className={[
                "h-[37px] shrink-0 whitespace-nowrap border-b-2 px-3 text-[11px] font-semibold transition-colors",
                section === s.id
                  ? "border-brand-orange bg-card text-brand-navy"
                  : "border-transparent text-muted-foreground hover:text-brand-navy",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Panel body */}
        <div className="flex min-h-0 flex-1 flex-col">
          {showFeature && <FeatureShowcase rows={rows} onSelect={onSelect} />}

          <div
            className={[
              "grid min-h-0 flex-1",
              readerOpen
                ? "lg:grid-cols-[340px_minmax(0,1fr)]"
                : "lg:grid-cols-[minmax(0,1fr)_300px]",
            ].join(" ")}
          >
            <div
              className={[
                "flex min-h-0 min-w-0 flex-col border-border/70 lg:border-r",
                readerOpen ? "hidden lg:flex" : "flex",
              ].join(" ")}
            >
              <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border/70 px-2.5 text-[11px] text-muted-foreground">
                <b className="font-semibold text-brand-navy">Top developments</b>
                {!readerOpen && (
                  <span className="hidden truncate xl:inline">
                    Ranked by recency, source quality, procedural significance and practice relevance
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ResultsPane
                  rows={listRows}
                  loading={isLoading}
                  error={error}
                  compact={readerOpen}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onTopic={onTopic}
                  emptyLabel={search ? "No signals match that filter." : EMPTY[section]}
                />
              </div>
            </div>

            {readerOpen && selected ? (
              <div className="min-h-0 min-w-0">
                <ReaderPane row={selected} onClose={() => setSelectedId(null)} onTopic={onTopic} />
              </div>
            ) : (
              <aside className="hidden min-h-0 min-w-0 border-l border-border/70 lg:block">
                <ContextRail matters={matters} filings={filings} alerts={alerts} />
              </aside>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
