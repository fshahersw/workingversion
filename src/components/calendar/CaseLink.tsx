import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { CalendarEvent } from "@/lib/calendar-types";

export function CaseLink({
  event,
  className,
  children,
}: {
  event: Pick<CalendarEvent, "inCorpus" | "matterSlug" | "matterName">;
  className?: string;
  children?: ReactNode;
}) {
  const label = children ?? event.matterName;
  if (event.inCorpus) {
    return (
      <Link to="/matters/$slug" params={{ slug: event.matterSlug }} className={className}>
        {label}
      </Link>
    );
  }
  return <span className={className}>{label}</span>;
}
