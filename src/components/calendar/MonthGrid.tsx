import { useLayoutEffect, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/calendar-types";
import { matterTone, todayISO } from "@/lib/calendar-types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PILLS = 3;
// Vertical budget per cell: day-number badge (~26px) + optional "+N more" line (~16px)
const CELL_CHROME_PX = 42;
const PILL_PX = 21;

export type MonthCell = {
  iso: string;
  day: number;
  inMonth: boolean;
  events: CalendarEvent[];
};

export function monthCells(year: number, month: number, events: CalendarEvent[]): MonthCell[] {
  const first = new Date(year, month, 1);
  const startPad = first.getDay();
  const start = new Date(year, month, 1 - startPad);
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    cells.push({
      iso,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      events: byDate.get(iso) ?? [],
    });
  }
  return cells;
}

export function MonthGrid({
  year,
  month,
  events,
  selected,
  onSelect,
}: {
  year: number;
  month: number;
  events: CalendarEvent[];
  selected: string | null;
  onSelect: (iso: string) => void;
}) {
  const cells = monthCells(year, month, events);
  const today = todayISO();

  // Adapt visible pills per day to the actual row height so short laptop
  // viewports never show half-clipped pills — overflow rolls into "+N more".
  const gridRef = useRef<HTMLDivElement>(null);
  const [maxPills, setMaxPills] = useState(MAX_PILLS);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => {
      const rowH = el.clientHeight / 6;
      const fit = Math.floor((rowH - CELL_CHROME_PX) / PILL_PX);
      setMaxPills(Math.max(0, Math.min(MAX_PILLS, fit)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="grid grid-cols-7 border-b border-border/70">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={gridRef} className="grid h-full min-h-0 grid-cols-7 grid-rows-6">
        {cells.map((cell) => {
          const extra = Math.max(0, cell.events.length - maxPills);
          const isToday = cell.iso === today;
          const isSelected = cell.iso === selected;
          return (
            <button
              key={cell.iso}
              type="button"
              onClick={() => onSelect(cell.iso)}
              className={[
                "flex min-h-0 flex-col items-stretch border-b border-r border-border/50 px-2 pb-1 pt-1.5 text-left transition-colors [&:nth-child(7n)]:border-r-0",
                "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-blue/40",
                !cell.inMonth ? "bg-muted/25" : "",
                isSelected ? "bg-brand-blue-soft/50 ring-1 ring-inset ring-brand-navy/25" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "mb-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11.5px] tabular-nums",
                  isToday
                    ? "bg-brand-orange font-semibold text-white shadow-sm"
                    : cell.inMonth
                      ? "font-medium text-brand-navy"
                      : "font-normal text-muted-foreground/55",
                ].join(" ")}
              >
                {cell.day}
              </span>
              <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-hidden">
                {cell.events.slice(0, maxPills).map((e) => {
                  const tone = matterTone(e.matterSlug);
                  return (
                    <span
                      key={e.id}
                      title={e.title}
                      className={[
                        "flex min-w-0 items-center gap-1 truncate rounded-[5px] border border-dashed px-1.5 py-px text-[10.5px] leading-tight",
                        tone.pill,
                        cell.inMonth ? "" : "opacity-60",
                      ].join(" ")}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="truncate">{e.title}</span>
                    </span>
                  );
                })}
                {extra > 0 && (
                  <span className="px-0.5 text-[10.5px] font-medium text-brand-navy/60">+{extra} more</span>
                )}
              </div>
            </button>

          );
        })}
        </div>
      </div>
    </div>
  );
}
