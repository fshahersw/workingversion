import { formatInTimeZone } from "date-fns-tz";
import type { Schedule } from "./types";
export function nextScheduledRun(schedule: Schedule, after = new Date()): string | null {
  if (!schedule.enabled) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
    throw new Error("Choose a valid schedule time.");
  if (schedule.frequency === "weekly" && !schedule.days.length)
    throw new Error("Choose at least one day.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format(after);
  } catch {
    throw new Error("Choose a valid time zone.");
  }
  // Search real instants: nonexistent DST times are skipped and ambiguous times are deterministic.
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let minute = 0; minute < 8 * 24 * 60; minute++) {
    const date = new Date(start + minute * 60000);
    if (formatInTimeZone(date, schedule.timezone, "HH:mm") !== schedule.time) continue;
    const day = Number(formatInTimeZone(date, schedule.timezone, "i")) % 7;
    if (schedule.frequency === "daily" || schedule.days.includes(day)) return date.toISOString();
  }
  throw new Error("No occurrence was found in the next eight days.");
}
export function scheduleDescription(schedule: Schedule) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${schedule.frequency === "daily" ? "Every day" : schedule.days.map((day) => days[day]).join(", ")} at ${schedule.time}`;
}
