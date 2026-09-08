import { Calendar, Check, Copy, Inbox, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DepIntel } from "./DepIntel";
import { KnowledgeGraph, type GraphFocus } from "./KnowledgeGraph";
import { Skeleton } from "@/components/ui/skeleton";
import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import {
  depInsights,
  displayCite,
  type DepAnalysis,
  type DepChronologyEvent,
  type DepContradiction,
  type DepExhibit,
  type DepFinding,
  type DepWitnessCard,
} from "@/lib/pile/deposition-analysis";
import type { PileHit } from "@/lib/pile/types";
import type { DepPass, DepPassStatus } from "@/lib/use-deposition";

export type AnalysisTab =
  | "ask"
  | "summary"
  | "admissions"
  | "impeachment"
  | "themes"
  | "intel"
  | "witnesses"
  | "contradictions"
  | "graph"
  | "objections"
  | "chronology"
  | "exhibits";

const TABS: {
  id: AnalysisTab;
  label: string;
  count?: (a: DepAnalysis) => number;
  pass?: DepPass;
}[] = [
  { id: "ask", label: "Ask" },
  { id: "summary", label: "Summary", pass: "case" },
  { id: "admissions", label: "Admissions", count: (a) => a.admissions.length, pass: "case" },
  { id: "impeachment", label: "Impeachment", count: (a) => a.impeachment.length, pass: "case" },
  { id: "themes", label: "Themes", count: (a) => a.themes.length, pass: "record" },
  { id: "intel", label: "Intelligence", pass: "connections" },
  { id: "witnesses", label: "Witnesses", count: (a) => a.witnesses.length, pass: "connections" },
  {
    id: "contradictions",
    label: "Conflicts",
    count: (a) => a.contradictions.length,
    pass: "connections",
  },
  { id: "graph", label: "Connections", count: (a) => a.graph.nodes.length, pass: "connections" },
  { id: "chronology", label: "Chronology", count: (a) => a.chronology.length, pass: "record" },
  { id: "exhibits", label: "Exhibits", count: (a) => a.exhibits.length, pass: "record" },
];

const GROUPS: { label: string; ids: AnalysisTab[] }[] = [
  { label: "Overview", ids: ["ask", "summary"] },
  { label: "Case", ids: ["admissions", "impeachment"] },
  { label: "Record", ids: ["themes", "chronology", "exhibits"] },
  { label: "Map", ids: ["intel", "witnesses", "contradictions", "graph"] },
];

function CiteButton({
  cite,
  fileName,
  onCite,
}: {
  cite: string;
  fileName?: string;
  onCite: (cite: string, fileName?: string) => void;
}) {
  if (!cite) return null;
  return (
    <button
      type="button"
      onClick={() => onCite(cite, fileName)}
      className="inline-flex items-center gap-1 rounded-md bg-brand-navy/8 px-1.5 py-0.5 font-mono text-[11px] text-brand-navy hover:bg-brand-navy/15"
    >
      <Pin className="h-3 w-3" />
      {displayCite(cite)}
    </button>
  );
}

function CopyCite({ cite }: { cite: string }) {
  const [done, setDone] = useState(false);
  if (!cite) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(displayCite(cite));
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : "Copy cite"}
    </button>
  );
}

function badgeClass(value: DepFinding["value"]) {
  if (value === "impeach") return "bg-destructive/10 text-destructive";
  if (value === "high") return "bg-emerald-50 text-emerald-800";
  return "bg-emerald-50 text-emerald-700";
}

function badgeLabel(value: DepFinding["value"]) {
  if (value === "impeach") return "Impeach";
  if (value === "high") return "High value";
  return "Helpful";
}

function useLabel(use: DepFinding["use"]) {
  if (use === "open") return "Open";
  if (use === "impeach") return "Impeach with";
  if (use === "notice") return "Notice";
  if (use === "auth") return "Authenticate";
  if (use === "gap") return "30(b)(6) gap";
  return "";
}

function FindingCard({
  item,
  onCite,
}: {
  item: DepFinding;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <article className="rounded-lg border border-border/80 bg-white px-4 py-3.5">
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${badgeClass(item.value)}`}
        >
          {useLabel(item.use) || badgeLabel(item.value)}
        </span>
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-foreground">
          {item.title}
        </h3>
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      </div>
      {item.tags.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {item.summary ? (
        <p className="mt-2 text-[13px] leading-relaxed text-foreground/90">{item.summary}</p>
      ) : null}
      {item.quote ? (
        <blockquote className="mt-3 rounded-lg bg-[#eef3fb] px-3 py-2.5 text-[13px] italic leading-relaxed text-foreground/90">
          “{item.quote}”
        </blockquote>
      ) : null}
      <div className="mt-2.5 flex items-center gap-3">
        <CiteButton cite={item.cite} onCite={onCite} />
        <CopyCite cite={item.cite} />
      </div>
    </article>
  );
}

function ProfileRow({
  item,
  onCite,
}: {
  item: DepFinding;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <li className="border-t border-border/60 py-3 first:border-t-0 first:pt-0">
      <p className="text-[13.5px] font-semibold leading-snug text-foreground">{item.title}</p>
      {item.quote ? (
        <p className="mt-1 text-[13px] italic leading-relaxed text-muted-foreground">
          “{item.quote}”
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2">
        <CiteButton cite={item.cite} onCite={onCite} />
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      </div>
    </li>
  );
}

function ChronologyItem({
  item,
  onCite,
}: {
  item: DepChronologyEvent;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <li className="relative pl-7">
      <span className="absolute left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-brand-navy/50 bg-card" />
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Calendar className="h-3.5 w-3.5" />
        {item.date}
      </div>
      <h3 className="text-[14px] font-semibold leading-snug text-foreground">{item.title}</h3>
      {item.summary ? (
        <p className="mt-1 text-[13px] leading-relaxed text-foreground/85">{item.summary}</p>
      ) : null}
      {item.quote ? (
        <blockquote className="mt-2 text-[13px] italic leading-relaxed text-muted-foreground">
          “{item.quote}”
        </blockquote>
      ) : null}
      <div className="mt-2">
        <CiteButton cite={item.cite} onCite={onCite} />
      </div>
    </li>
  );
}

function ExhibitCard({
  item,
  onCite,
}: {
  item: DepExhibit;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <article className="rounded-lg border border-border/80 bg-white px-4 py-3.5">
      <h3 className="text-[14px] font-semibold text-foreground">{item.name}</h3>
      {item.summary ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/85">{item.summary}</p>
      ) : null}
      {item.quote ? (
        <p className="mt-2 text-[13px] italic text-muted-foreground">“{item.quote}”</p>
      ) : null}
      <div className="mt-2">
        <CiteButton cite={item.cite} onCite={onCite} />
      </div>
    </article>
  );
}

function PassSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-navy/20 border-t-brand-navy" />
        Analyzing {label}…
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card px-4 py-4">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-5/6" />
        </div>
      ))}
    </div>
  );
}

function EmptyList({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/80 px-4 py-10 text-center">
      <Inbox className="h-5 w-5 text-slate-300" strokeWidth={1.75} />
      <p className="text-[13px] font-medium text-slate-500">
        No {label} extracted from this transcript yet.
      </p>
    </div>
  );
}

function WitnessCard({
  item,
  onCite,
}: {
  item: DepWitnessCard;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <article className="rounded-lg border border-border/80 bg-white px-4 py-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold text-foreground">{item.name}</h3>
        {item.role ? <span className="text-[12px] text-muted-foreground">{item.role}</span> : null}
      </div>
      {item.fileName ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{item.fileName}</p>
      ) : null}
      {item.summary ? (
        <p className="mt-2 text-[13px] leading-relaxed text-foreground/90">{item.summary}</p>
      ) : null}
      {item.quote ? (
        <p className="mt-2 text-[13px] italic text-muted-foreground">“{item.quote}”</p>
      ) : null}
      <div className="mt-2">
        <CiteButton cite={item.cite} fileName={item.fileName} onCite={onCite} />
      </div>
    </article>
  );
}

function ContradictionCard({
  item,
  onCite,
}: {
  item: DepContradiction;
  onCite: (cite: string, fileName?: string) => void;
}) {
  return (
    <article className="rounded-lg border border-border/80 bg-white px-4 py-3.5">
      <h3 className="text-[14px] font-semibold text-foreground">{item.title}</h3>
      {item.tags.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {item.summary ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/90">{item.summary}</p>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {[item.a, item.b].map((side, i) => (
          <div key={i} className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {side.witness || (i === 0 ? "A" : "B")}
            </p>
            {side.fileName ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">{side.fileName}</p>
            ) : null}
            {side.quote ? (
              <p className="mt-1 text-[12.5px] italic leading-relaxed">“{side.quote}”</p>
            ) : null}
            <div className="mt-1.5">
              <CiteButton cite={side.cite} fileName={side.fileName} onCite={onCite} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function InsightsStrip({
  analysis,
  onOpen,
}: {
  analysis: DepAnalysis;
  onOpen: (tab: AnalysisTab) => void;
}) {
  const s = depInsights(analysis);
  const all: { label: string; n: number; tab: AnalysisTab }[] = [
    { label: "High value", n: s.high, tab: "admissions" },
    { label: "Notice", n: s.notice, tab: "admissions" },
    { label: "Impeach", n: s.impeach, tab: "impeachment" },
    { label: "Gaps", n: s.gaps, tab: "admissions" },
    { label: "Conflicts", n: s.conflicts, tab: "contradictions" },
    { label: "Exhibits", n: s.exhibits, tab: "exhibits" },
    { label: "People", n: s.people, tab: "witnesses" },
    { label: "Links", n: s.edges, tab: "graph" },
  ];
  const cells = all.filter((c) => c.n > 0);
  if (!cells.length) return null;
  return (
    <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={() => onOpen(c.tab)}
          className="flex min-h-[54px] flex-col justify-center rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-brand-navy/30 hover:bg-slate-50"
        >
          <p className="text-[16px] font-semibold tabular-nums text-slate-900">{c.n}</p>
          <p className="text-[11px] text-slate-500">{c.label}</p>
        </button>
      ))}
    </div>
  );
}

export function DepositionAnalysisPane({
  analyzing,
  analysis,
  passes,
  role,
  answer,
  hits,
  asking,
  onCite,
  onTabChange,
  transcripts,
  onAsk,
}: {
  analyzing: boolean;
  analysis: DepAnalysis | null;
  passes: Record<DepPass, DepPassStatus>;
  role: string;
  answer?: string;
  hits?: PileHit[];
  asking?: boolean;
  onCite: (cite: string, fileName?: string) => void;
  onTabChange?: (tab: AnalysisTab) => void;
  /** Source transcripts; enables cross-witness graph controls when there are several. */
  transcripts?: { fileId: string; fileName: string; witness?: string | null }[];
  /** Runs an Ask from the graph dossier ("Ask about this"). */
  onAsk?: (question: string) => void;
}) {
  const [tab, setTab] = useState<AnalysisTab>("summary");
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const selectTab = (next: AnalysisTab) => {
    setTab(next);
    onTabChange?.(next);
  };
  const openGraphAt = (nodeId: string) => {
    setGraphFocus({ id: nodeId, n: Date.now() });
    selectTab("graph");
  };
  // Jump to Ask only on the transition into a new ask — not on every render,
  // otherwise manual tab clicks get snapped back while an answer is present.
  // Asks issued from the knowledge graph render inline there and never jump.
  const tabChangeRef = useRef(onTabChange);
  tabChangeRef.current = onTabChange;
  const prevAsking = useRef(false);
  const askFromGraph = useRef(false);
  useEffect(() => {
    if (asking && !prevAsking.current) {
      if (askFromGraph.current) {
        askFromGraph.current = false;
      } else {
        setTab("ask");
        tabChangeRef.current?.("ask");
      }
    }
    prevAsking.current = !!asking;
  }, [asking]);
  const onGraphAsk = onAsk
    ? (question: string) => {
        askFromGraph.current = true;
        onAsk(question);
      }
    : undefined;
  const visibleTabs = TABS.filter(
    (t) => t.id !== "objections" || (analysis?.objections.length ?? 0) > 0,
  );
  const tabPass = TABS.find((t) => t.id === tab)?.pass;
  const tabRunning = tabPass ? passes[tabPass] === "running" : analyzing;
  const runningCount = Object.values(passes).filter((p) => p === "running").length;

  const heading =
    tab === "summary"
      ? "Witness profile"
      : tab === "ask"
        ? "Ask the transcripts"
        : tab === "intel"
          ? (transcripts?.length ?? 0) > 1
            ? "Cross-deposition intelligence"
            : "Record intelligence"
          : TABS.find((t) => t.id === tab)?.label;

  return (
    <section className="flex h-full min-h-0 min-w-0 overflow-hidden bg-card">
      <nav className="wr-app-scroll flex w-[172px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface pt-0">
        <div className="flex h-11 items-center border-b border-border px-3">
          <p className="text-[13px] font-semibold text-slate-900">Analysis</p>
        </div>
        {GROUPS.map((group) => {
          const items = group.ids
            .map((id) => visibleTabs.find((t) => t.id === id))
            .filter((t): t is (typeof TABS)[number] => !!t);
          if (!items.length) return null;
          return (
            <div key={group.label} className="mb-3 px-2 pt-3 last:mb-0">
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {items.map((t) => {
                  const count = analysis && t.count ? t.count(analysis) : undefined;
                  const busy = t.pass ? passes[t.pass] === "running" : false;
                  const on = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => selectTab(t.id)}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] ${
                        on
                          ? "bg-brand-navy text-white"
                          : "text-slate-600 hover:bg-surface-strong hover:text-slate-900"
                      }`}
                    >
                      <span className="font-medium">{t.label}</span>
                      {busy ? (
                        <span
                          className={`h-3 w-3 animate-spin rounded-full border-2 border-t-transparent ${
                            on ? "border-white/70 border-t-transparent" : "border-brand-navy/40"
                          }`}
                        />
                      ) : count != null ? (
                        <span
                          className={`tabular-nums text-[11px] ${on ? "text-white/75" : "text-slate-400"}`}
                        >
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <p className="text-[13px] font-semibold text-slate-900">{heading}</p>
          {role && tab === "summary" ? (
            <p className="truncate text-[12px] text-slate-500">{role}</p>
          ) : null}
        </div>
        <div
          className={`wr-app-scroll min-h-0 flex-1 overflow-y-auto px-4 ${tab === "graph" ? "py-3" : "py-4"}`}
        >
          {runningCount > 0 && tab === "summary" && !analysis?.summary ? (
            <p className="mb-3 text-[12px] text-muted-foreground">
              Analyzing in parallel — {runningCount} specialist{" "}
              {runningCount === 1 ? "pass" : "passes"} still running.
            </p>
          ) : null}

          {tab === "ask" ? (
            asking && !answer ? (
              <PassSkeleton label="retrieved testimony" />
            ) : answer ? (
              <div>
                <AnswerMarkdown
                  text={answer}
                  streaming={!!asking}
                  onCite={(ref) => {
                    const n = Number(String(ref).replace(/^S/i, ""));
                    const hit = (hits ?? [])[n - 1];
                    if (hit) onCite(hit.cite || `${hit.page}:1`, hit.fileName);
                  }}
                />
                {(hits ?? []).length ? (
                  <ul className="mt-5 space-y-2 border-t border-border/60 pt-4">
                    {(hits ?? []).map((h, i) => (
                      <li key={`${h.fileId}:${h.page}:${i}`}>
                        <button
                          type="button"
                          onClick={() => onCite(h.cite || `${h.page}:1`, h.fileName)}
                          className="w-full rounded-lg border border-transparent px-3 py-2 text-left hover:border-border hover:bg-card"
                        >
                          <p className="text-[12.5px] font-medium text-foreground">
                            S{i + 1} · {h.fileName}
                            <span className="ml-1.5 font-mono text-[11px] text-brand-navy">
                              {h.cite || `p. ${h.page}`}
                            </span>
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                            {h.snippet}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed text-slate-500">
                Use <span className="font-medium text-slate-700">Ask the set</span> above. Retrieval
                pulls the best passages from every uploaded transcript, then answers only from those
                hits.
              </p>
            )
          ) : null}

          {tab === "summary" ? (
            tabRunning && !analysis?.summary ? (
              <PassSkeleton label="witness profile" />
            ) : (
              <div>
                {analysis ? <InsightsStrip analysis={analysis} onOpen={selectTab} /> : null}
                {analysis?.summary ? (
                  <p className="mb-4 text-[13.5px] leading-[1.75] text-foreground/90">
                    {analysis.summary}
                  </p>
                ) : (
                  <p className="mb-4 text-[13px] text-muted-foreground">No witness profile yet.</p>
                )}
                <ul>
                  {(analysis?.profile ?? []).map((item) => (
                    <ProfileRow key={item.id} item={item} onCite={onCite} />
                  ))}
                </ul>
              </div>
            )
          ) : null}

          {tab === "admissions" ? (
            tabRunning && !analysis?.admissions.length ? (
              <PassSkeleton label="admissions" />
            ) : analysis?.admissions.length ? (
              <div className="space-y-3">
                {analysis.admissions.map((item) => (
                  <FindingCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="admissions" />
            )
          ) : null}

          {tab === "impeachment" ? (
            tabRunning && !analysis?.impeachment.length ? (
              <PassSkeleton label="impeachment" />
            ) : (
              <div className="space-y-3">
                {(analysis?.impeachment ?? []).map((item) => (
                  <FindingCard key={item.id} item={item} onCite={onCite} />
                ))}
                {!analysis?.impeachment.length && !tabRunning ? (
                  <EmptyList label="impeachment" />
                ) : null}
              </div>
            )
          ) : null}

          {tab === "themes" ? (
            tabRunning && !analysis?.themes.length ? (
              <PassSkeleton label="themes" />
            ) : analysis?.themes.length ? (
              <div className="space-y-3">
                {analysis.themes.map((item) => (
                  <FindingCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="case themes" />
            )
          ) : null}

          {tab === "intel" ? (
            tabRunning && !analysis?.contradictions.length && !analysis?.graph.nodes.length ? (
              <PassSkeleton label="cross-deposition intelligence" />
            ) : analysis ? (
              <DepIntel
                analysis={analysis}
                transcripts={transcripts ?? []}
                passes={passes}
                onCite={onCite}
                onOpenTab={selectTab}
                onOpenGraph={openGraphAt}
                onAsk={onAsk}
              />
            ) : (
              <EmptyList label="intelligence" />
            )
          ) : null}

          {tab === "witnesses" ? (
            tabRunning && !analysis?.witnesses.length ? (
              <PassSkeleton label="witnesses" />
            ) : analysis?.witnesses.length ? (
              <div className="space-y-3">
                {analysis.witnesses.map((item) => (
                  <WitnessCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="witness cards" />
            )
          ) : null}

          {tab === "contradictions" ? (
            tabRunning && !analysis?.contradictions.length ? (
              <PassSkeleton label="conflicts" />
            ) : analysis?.contradictions.length ? (
              <div className="space-y-3">
                {analysis.contradictions.map((item) => (
                  <ContradictionCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="conflicts" />
            )
          ) : null}

          {tab === "graph" ? (
            tabRunning && !analysis?.graph.nodes.length ? (
              <PassSkeleton label="connections" />
            ) : analysis?.graph.nodes.length ? (
              <KnowledgeGraph
                analysis={analysis}
                onCite={onCite}
                multi={(transcripts?.length ?? 0) > 1}
                transcripts={transcripts}
                onAsk={onGraphAsk}
                answer={answer}
                asking={asking}
                hits={hits}
                focus={graphFocus}
              />
            ) : (
              <EmptyList label="connections" />
            )
          ) : null}

          {tab === "objections" ? (
            analysis?.objections.length ? (
              <div className="space-y-3">
                {analysis.objections.map((item) => (
                  <FindingCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="objections" />
            )
          ) : null}

          {tab === "chronology" ? (
            tabRunning && !analysis?.chronology.length ? (
              <PassSkeleton label="chronology" />
            ) : analysis?.chronology.length ? (
              <ol className="relative ml-1.5 space-y-6 border-l border-border">
                {analysis.chronology.map((item) => (
                  <ChronologyItem key={item.id} item={item} onCite={onCite} />
                ))}
              </ol>
            ) : (
              <EmptyList label="dated events" />
            )
          ) : null}

          {tab === "exhibits" ? (
            tabRunning && !analysis?.exhibits.length ? (
              <PassSkeleton label="exhibits" />
            ) : analysis?.exhibits.length ? (
              <div className="space-y-3">
                {analysis.exhibits.map((item) => (
                  <ExhibitCard key={item.id} item={item} onCite={onCite} />
                ))}
              </div>
            ) : (
              <EmptyList label="exhibits" />
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}
