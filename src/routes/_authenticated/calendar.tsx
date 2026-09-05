import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { CalendarView } from "@/components/calendar/CalendarView";

export const Route = createFileRoute("/_authenticated/calendar")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Calendar — Seeger Weiss" },
      {
        name: "description",
        content: "Upcoming deadlines and hearings on corpus matters from DocketBird AutoCalendar.",
      },
    ],
  }),
  component: CalendarPage,
});

function CalendarPage() {
  return (
    <AppShell>
      <CalendarView />
    </AppShell>
  );
}
