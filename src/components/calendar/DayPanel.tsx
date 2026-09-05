import { X } from "lucide-react";

import { CaseLink } from "@/components/calendar/CaseLink";
import type { CalendarEvent } from "@/lib/calendar-types";
import { formatDayHeading, matterTone } from "@/lib/calendar-types";

export function DayPanel({
  date,
  events,
  onClose,
}: {
  date: string;
  events: CalendarEvent[];
  onClose: () => void;
}) {
  const byMatter = new Map<string, { name: string; slug: string; caseId: string; inCorpus: boolean; rows: CalendarEvent[] }>();
  for (const e of events) {
    const cur = byMatter.get(e.matterSlug);
    if (cur) cur.rows.push(e);
    else byMatter.set(e.matterSlug, { name: e.matterName, slug: e.matterSlug, caseId: e.caseId, inCorpus: e.inCorpus, rows: [e] });
  }
  const groups = [...byMatter.values()];

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-[#eef2f6] px-5 py-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[28px] leading-tight text-brand-navy">{formatDayHeading(date)}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {events.length} deadline{events.length === 1 ? "" : "s"}
              {groups.length ? ` · ${groups.length} case${groups.length === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] font-medium text-brand-navy hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>

        {events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground">
            No firm deadlines on this day.
          </div>
        ) : (
          <div className="space-y-3 pb-10">
            {groups.map((g) => {
              const tone = matterTone(g.slug);
              return (
                <section key={g.slug} className="overflow-hidden rounded-xl border border-border/70 bg-card">
                  <div className="flex">
                    <div className={`w-1.5 shrink-0 ${tone.bar}`} />
                    <div className="min-w-0 flex-1 px-4 py-3">
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <CaseLink
                          event={{ inCorpus: g.inCorpus, matterSlug: g.slug, matterName: g.name }}
                          className="font-display text-[16px] font-semibold italic text-brand-navy hover:underline"
                        />
                        <span className="font-mono text-[11px] text-muted-foreground">{g.caseId}</span>
                      </div>
                      <ul>
                        {g.rows.map((e) => (
                          <li
                            key={e.id}
                            className="flex items-start gap-3 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"
                          >
                            <span className="w-[64px] shrink-0 pt-0.5 text-[11.5px] text-muted-foreground">
                              {e.time ? e.time.slice(0, 5) : "all day"}
                            </span>
                            <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-brand-navy">{e.title}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
