import { useQuery } from "@tanstack/react-query";

import { getCorpusSignals, getIntelFeed, getIntelStatus } from "@/lib/intel.functions";
import { SECTIONS, type CorpusSignal, type IntelItem, type SectionId } from "@/lib/intel-types";

export type Priority = "critical" | "high" | "monitor" | "research";

export type TerminalRow = {
  id: string;
  /** Media rows carry a thumbnail; document rows are text-only. */
  kind: "media" | "document";
  title: string;
  detail: string;
  /** Second half of the summary (sentence 2+), shown as the context strip. */
  analysis: string;
  badge: string | null;
  source: string | null;
  faviconUrl: string | null;
  imageUrl: string | null;
  score: number | null;
  timestamp: string | null;
  matterSlug: string | null;
  matterLabel: string | null;
  meta: string[];
  /** Cached AI briefing bullets generated during the backend run. */
  bullets: string[];
  impact: string | null;
  url: string | null;
  priority: Priority;
  intel: IntelItem | null;
};

/** Split a summary into a lead sentence and the remainder. */
function splitSummary(text: string): { lead: string; rest: string } {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { lead: "", rest: "" };
  const m = clean.match(/^(.+?[.!?])\s+(.*)$/);
  if (!m || !m[2] || m[1]!.length < 40) return { lead: clean, rest: "" };
  return { lead: m[1]!, rest: m[2]! };
}

function priorityOf(score: number | null, category: string | null): Priority {
  const cat = (category ?? "").toLowerCase();
  if (cat === "research") return "research";
  if (score !== null && score >= 82) return "critical";
  if (score !== null && score >= 66) return "high";
  return "monitor";
}

function fromIntel(i: IntelItem): TerminalRow {
  const { lead, rest } = splitSummary(i.summary ?? "");
  return {
    id: i.id,
    kind: "media",
    title: i.title,
    detail: i.analysisLead ?? lead,
    analysis: i.impact ?? rest,
    badge: i.category,
    source: i.sourceName ?? i.sourceDomain,
    faviconUrl: i.faviconUrl,
    imageUrl: i.imageKind === "editorial" ? i.imageUrl : null,
    score: i.signalScore,
    timestamp: i.publishedAt ?? i.fetchedAt,
    matterSlug: i.matterSlug,
    matterLabel: i.matterLabel,
    meta: i.relatedTopics.slice(0, 5),
    bullets: i.bullets,
    impact: i.impact,
    url: i.url,
    priority: priorityOf(i.signalScore, i.category),
    intel: i,
  };
}

function fromSignal(sig: CorpusSignal): TerminalRow {
  const { lead, rest } = splitSummary(sig.detail);
  return {
    id: sig.id,
    kind: "document",
    title: sig.title,
    detail: lead,
    analysis: sig.impact ?? rest,
    badge: sig.badge,
    source: sig.matterLabel,
    faviconUrl: null,
    imageUrl: null,
    score: null,
    timestamp: sig.timestamp,
    matterSlug: sig.matterSlug,
    matterLabel: sig.matterLabel,
    meta: sig.meta,
    bullets: sig.bullets,
    impact: sig.impact,
    url: null,
    priority: sig.kind === "alert" ? "high" : "monitor",
    intel: null,
  };
}

/**
 * Interleave the wider litigation wire with our own corpus records: two
 * headlines for every internal row, so a corpus tab is never limited to the
 * handful of matters we hold while still surfacing our own docket activity.
 */
function weave(news: TerminalRow[], ours: TerminalRow[]): TerminalRow[] {
  const out: TerminalRow[] = [];
  let n = 0;
  let o = 0;
  while (n < news.length || o < ours.length) {
    for (let k = 0; k < 2 && n < news.length; k++) out.push(news[n++] as TerminalRow);
    if (o < ours.length) out.push(ours[o++] as TerminalRow);
  }
  return out;
}

export function useTerminalRows(section: SectionId, search: string) {
  const origin = SECTIONS.find((s) => s.id === section)?.origin ?? "intel";
  const q = search.trim();

  // Corpus tabs blend our own records with the live litigation wire, so the
  // intel query runs for every section — not just the intel-origin ones.
  const intel = useQuery({
    queryKey: ["intel-feed", section, q],
    staleTime: 60_000,
    queryFn: () => getIntelFeed({ data: { section, search: q || undefined, limit: 120 } }),
  });

  const corpus = useQuery({
    queryKey: ["corpus-signals", section],
    enabled: origin === "corpus",
    staleTime: 60_000,
    queryFn: () => getCorpusSignals({ data: { section } }),
  });

  const newsRows = (intel.data?.items ?? []).map(fromIntel);
  let rows: TerminalRow[] = [];
  if (origin === "intel") rows = newsRows;
  else {
    let ours = (corpus.data ?? []).map(fromSignal);
    if (q) {
      const needle = q.toLowerCase();
      ours = ours.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.detail.toLowerCase().includes(needle) ||
          (r.matterLabel ?? "").toLowerCase().includes(needle),
      );
    }
    rows = weave(newsRows, ours);
  }

  return {
    rows,
    isLoading: origin === "intel" ? intel.isLoading : corpus.isLoading && intel.isLoading,
    error: origin === "intel" ? intel.error : corpus.error,
    origin,
  };
}

/** Corpus data powering the context rail modules and the toolbar metrics. */
export function useRailData() {
  const matters = useQuery({
    queryKey: ["corpus-signals", "mdl"],
    staleTime: 300_000,
    queryFn: () => getCorpusSignals({ data: { section: "mdl" } }),
  });
  const filings = useQuery({
    queryKey: ["corpus-signals", "filings"],
    staleTime: 300_000,
    queryFn: () => getCorpusSignals({ data: { section: "filings" } }),
  });
  const alerts = useQuery({
    queryKey: ["corpus-signals", "alerts"],
    staleTime: 300_000,
    queryFn: () => getCorpusSignals({ data: { section: "alerts" } }),
  });
  return {
    matters: matters.data ?? [],
    filings: filings.data ?? [],
    alerts: alerts.data ?? [],
  };
}

export function useIntelStatus() {
  return useQuery({
    queryKey: ["intel-status"],
    staleTime: 60_000,
    queryFn: () => getIntelStatus(),
  });
}

export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Days since an ISO timestamp, or null when unparseable. */
export function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

export function severityOf(score: number | null): "critical" | "watch" | "routine" {
  if (score === null) return "routine";
  if (score >= 78) return "critical";
  if (score >= 58) return "watch";
  return "routine";
}
