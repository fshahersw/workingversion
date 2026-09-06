import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

import type { CalendarPage } from "./calendar-types";

export const getCorpusCalendar = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CalendarPage> => {
    const { loadCorpusCalendar } = await import("./calendar.server");
    try {
      return await loadCorpusCalendar();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load the calendar.";
      return {
        days: 180,
        windowStart: null,
        windowEnd: null,
        lastUpdated: null,
        events: [],
        matters: [],
        error: message,
      };
    }
  });
