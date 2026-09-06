import { getCompanyCalendar } from "./agents/docketbird.server";
import type { CalendarEvent, CalendarMatter, CalendarPage } from "./calendar-types";
import { requiredEnv } from "./config.server";
import { corpusUrl } from "./corpus";
import { rpc, restSelect } from "./ingest/store.server";

const CORE_RE = /(\d{2,4})-([a-z]+)-(\d+)/i;

export function docketCore(value: string | null | undefined): string | null {
  const m = CORE_RE.exec(value || "");
  if (!m) return null;
  const year = m[1].length === 2 ? `20${m[1]}` : m[1];
  return `${year}-${m[2].toLowerCase()}-${String(parseInt(m[3], 10))}`;
}

function fingerprint(caseId: string, date: string, time: string | null, title: string): string {
  return `${caseId}|${date}|${time ?? ""}|${title}`;
}

type MatterRow = { matterId: string; slug: string; name: string; docketNumber: string };

async function listMatterDockets(): Promise<MatterRow[]> {
  const k = requiredEnv("CORPUS_SERVICE_KEY");
  const qs = new URLSearchParams({
    select: "matter_id,slug,short_name,case_name,docket_number",
    order: "short_name.asc",
  });
  const res = await fetch(`${corpusUrl()}/rest/v1/corpus_matters?${qs}`, {
    headers: { apikey: k, Authorization: `Bearer ${k}` },
  });
  if (!res.ok) throw new Error(`Corpus matters: ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((m) => ({
    matterId: String(m["matter_id"] ?? ""),
    slug: String(m["slug"] ?? ""),
    name: String(m["short_name"] || m["case_name"] || m["slug"] || ""),
    docketNumber: String(m["docket_number"] ?? ""),
  }));
}

type CachedRow = {
  fingerprint: string;
  matter_slug: string;
  matter_name: string;
  case_id: string;
  case_name: string;
  event_date: string;
  event_time: string | null;
  title: string;
  source_document_id: string | null;
  in_corpus: boolean | null;
  last_seen_at: string | null;
};

function toEvents(rows: CachedRow[]): { events: CalendarEvent[]; matters: CalendarMatter[]; lastUpdated: string | null } {
  const events: CalendarEvent[] = [];
  const counts = new Map<string, CalendarMatter>();
  let lastUpdated: string | null = null;
  for (const row of rows) {
    const inCorpus = row.in_corpus === true;
    events.push({
      id: row.fingerprint,
      date: String(row.event_date).slice(0, 10),
      time: row.event_time,
      title: row.title,
      caseId: row.case_id,
      caseName: row.case_name,
      sourceDocumentId: row.source_document_id,
      matterSlug: row.matter_slug,
      matterName: row.matter_name,
      inCorpus,
    });
    const prev = counts.get(row.matter_slug);
    if (prev) prev.count += 1;
    else counts.set(row.matter_slug, { slug: row.matter_slug, name: row.matter_name, count: 1, inCorpus });
    if (row.last_seen_at && (!lastUpdated || row.last_seen_at > lastUpdated)) lastUpdated = row.last_seen_at;
  }
  events.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.time || "99:99").localeCompare(b.time || "99:99") || a.title.localeCompare(b.title);
  });
  return {
    events,
    matters: [...counts.values()].sort((a, b) => {
      if (a.inCorpus !== b.inCorpus) return a.inCorpus ? -1 : 1;
      return b.count - a.count || a.name.localeCompare(b.name);
    }),
    lastUpdated,
  };
}

export async function syncCorpusCalendar(days = 180): Promise<{
  matched: number;
  upserted: number;
  pruned: number;
  skipped: number;
}> {
  const windowDays = Math.min(Math.max(days, 1), 180);
  const [matters, rollup] = await Promise.all([
    listMatterDockets(),
    getCompanyCalendar(windowDays),
  ]);

  const byCore = new Map<string, MatterRow>();
  for (const m of matters) {
    const core = docketCore(m.docketNumber);
    if (core) byCore.set(core, m);
  }

  const entries = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const row of rollup.entries) {
    const matter = byCore.get(docketCore(row.caseId) || "");
    const fp = fingerprint(row.caseId, row.date, row.time, row.title);
    entries.set(fp, {
      fingerprint: fp,
      matter_id: matter?.matterId || null,
      matter_slug: matter?.slug || row.caseId,
      matter_name: matter?.name || row.caseName,
      case_id: row.caseId,
      case_name: row.caseName,
      event_date: row.date,
      event_time: row.time,
      title: row.title,
      source_document_id: row.sourceDocumentId,
      in_corpus: Boolean(matter),
    });
  }

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fallbackEnd = new Date(today);
  fallbackEnd.setUTCDate(fallbackEnd.getUTCDate() + windowDays);

  const result = await rpc<{ matched: number; upserted: number; pruned: number }>("corpus_calendar_sync", {
    payload: {
      window_start: rollup.windowStart?.slice(0, 10) || iso(today),
      window_end: rollup.windowEnd?.slice(0, 10) || iso(fallbackEnd),
      source_updated: rollup.lastUpdated,
      skipped,
      entries: [...entries.values()],
    },
  });
  return { ...result, skipped };
}

async function readCached(): Promise<CachedRow[]> {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 14);
  const qs = new URLSearchParams({
    select: "fingerprint,matter_slug,matter_name,case_id,case_name,event_date,event_time,title,source_document_id,in_corpus,last_seen_at",
    event_date: `gte.${from.toISOString().slice(0, 10)}`,
    order: "event_date.asc,event_time.asc.nullsfirst",
    limit: "4000",
  });
  return restSelect<CachedRow[]>(`corpus_calendar_entries?${qs}`);
}

export async function loadCorpusCalendar(): Promise<CalendarPage> {
  let rows = await readCached();
  if (rows.length === 0) {
    await syncCorpusCalendar(180);
    rows = await readCached();
  }
  const { events, matters, lastUpdated } = toEvents(rows);
  const dates = events.map((e) => e.date);
  return {
    days: 180,
    windowStart: dates[0] ?? null,
    windowEnd: dates[dates.length - 1] ?? null,
    lastUpdated,
    events,
    matters,
  };
}
