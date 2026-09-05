export type CalendarEvent = {
  id: string;
  date: string;
  time: string | null;
  title: string;
  caseId: string;
  caseName: string;
  sourceDocumentId: string | null;
  matterSlug: string;
  matterName: string;
  inCorpus: boolean;
};

export type CalendarMatter = {
  slug: string;
  name: string;
  count: number;
  inCorpus: boolean;
};

export type CalendarPage = {
  days: number;
  windowStart: string | null;
  windowEnd: string | null;
  lastUpdated: string | null;
  events: CalendarEvent[];
  matters: CalendarMatter[];
  error?: string;
};

export type CalendarViewMode = "month" | "agenda" | "cases";

export const MATTER_TONES = [
  {
    pill: "border-orange-300/80 bg-orange-50 text-orange-950",
    dot: "bg-orange-500",
    bar: "bg-orange-400",
  },
  {
    pill: "border-emerald-300/80 bg-emerald-50 text-emerald-950",
    dot: "bg-emerald-600",
    bar: "bg-emerald-500",
  },
  {
    pill: "border-rose-300/80 bg-rose-50 text-rose-950",
    dot: "bg-rose-500",
    bar: "bg-rose-400",
  },
  {
    pill: "border-violet-300/80 bg-violet-50 text-violet-950",
    dot: "bg-violet-500",
    bar: "bg-violet-400",
  },
  {
    pill: "border-sky-300/80 bg-sky-50 text-sky-950",
    dot: "bg-sky-500",
    bar: "bg-sky-400",
  },
  {
    pill: "border-amber-300/80 bg-amber-50 text-amber-950",
    dot: "bg-amber-600",
    bar: "bg-amber-500",
  },
] as const;

export function matterTone(slug: string): (typeof MATTER_TONES)[number] {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return MATTER_TONES[h % MATTER_TONES.length];
}

export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDayHeading(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatMonthTitle(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function shortCaseLabel(name: string): string {
  const cleaned = name.replace(/^in\s+re:?\s*/i, "").trim();
  if (cleaned.length <= 44) return cleaned;
  return `${cleaned.slice(0, 42).trim()}…`;
}
