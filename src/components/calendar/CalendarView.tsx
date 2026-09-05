import { CalendarDays } from "lucide-react";

export function CalendarView() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-5 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-blue-soft text-brand-navy">
        <CalendarDays className="h-5 w-5" />
      </span>
      <h1 className="mt-4 text-[17px] font-semibold text-foreground">Calendar</h1>
      <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">
        The firm calendar is paused. Check back later for updates.
      </p>
    </div>
  );
}
