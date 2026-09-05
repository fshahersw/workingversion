import { Fragment } from "react";
import { ArrowRight, ExternalLink, FileText, Loader2 } from "lucide-react";

import { relTime, shortDate, type Priority, type TerminalRow } from "./useTerminalData";

const PRIORITY_LABEL: Record<Priority, string> = {
  critical: "Critical",
  high: "High",
  monitor: "Monitor",
  research: "Research",
};

const PRIORITY_CLASS: Record<Priority, string> = {
  critical: "text-destructive",
  high: "text-destructive/85",
  monitor: "text-brand-orange",
  research: "text-brand-blue",
};

/** "Today" / "Yesterday" / "Aug 24" bucket for the sticky day dividers. */
function dayKey(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Undated";
  const today = new Date();
  const diff = Math.floor(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
      86_400_000,
  );
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ResultsPane({
  rows,
  loading,
  error,
  compact,
  selectedId,
  onSelect,
  onTopic,
  emptyLabel,
}: {
  rows: TerminalRow[];
  loading: boolean;
  error: unknown;
  compact: boolean;
  selectedId: string | null;
  onSelect: (row: TerminalRow) => void;
  onTopic: (topic: string) => void;
  emptyLabel: string;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading signals…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
        Couldn’t load this section right now.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText className="h-5 w-5 text-muted-foreground/50" />
        <p className="text-[12px] text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  let lastDay = "";
  return (
    <ul>
      {rows.map((row, i) => {
        const day = dayKey(row.timestamp);
        const divider = day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={row.id || `${i}`}>
            {divider && (
              <li className="sticky top-0 z-[5] border-y border-border/70 bg-muted/85 px-2.5 py-[3px] text-[8.5px] font-bold uppercase tracking-[0.09em] text-muted-foreground backdrop-blur">
                {day}
              </li>
            )}
            <ResultRow
              row={row}
              compact={compact}
              selected={selectedId === row.id}
              onSelect={onSelect}
              onTopic={onTopic}
            />
          </Fragment>
        );
      })}
    </ul>
  );
}

function ResultRow({
  row,
  compact,
  selected,
  onSelect,
  onTopic,
}: {
  row: TerminalRow;
  compact: boolean;
  selected: boolean;
  onSelect: (row: TerminalRow) => void;
  onTopic: (topic: string) => void;
}) {
  const isDoc = row.kind === "document";
  const cols = isDoc
    ? compact
      ? "grid-cols-[minmax(0,1fr)]"
      : "grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_62px]"
    : compact
      ? "grid-cols-[64px_minmax(0,1fr)]"
      : "grid-cols-[minmax(0,1fr)] sm:grid-cols-[124px_minmax(0,1fr)_62px]";

  return (
    <li
      className={[
        "grid gap-3 border-b border-border/70 p-2.5 transition-colors",
        cols,
        selected
          ? "bg-brand-blue-soft/70 shadow-[inset_3px_0_0_var(--brand-orange)]"
          : "hover:bg-muted/40",
      ].join(" ")}
    >
      {!isDoc && (
        <button
          type="button"
          onClick={() => onSelect(row)}
          aria-label={`Open ${row.title}`}
          className={[
            "overflow-hidden rounded-sm bg-muted",
            compact ? "h-11 w-16" : "hidden h-[76px] w-[124px] sm:block",
          ].join(" ")}
        >
          {row.imageUrl ? (
            <img src={row.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full flex-col items-center justify-center gap-1 bg-brand-navy/90 px-1 text-center text-primary-foreground">
              {row.faviconUrl && (
                <img src={row.faviconUrl} alt="" loading="lazy" className="h-4 w-4 rounded-[2px] opacity-90" />
              )}
              <span className="line-clamp-1 font-display text-[9px] uppercase tracking-[0.12em] opacity-90">
                {row.badge ?? row.source ?? "Seeger Weiss"}
              </span>
            </span>
          )}
        </button>
      )}

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9.5px] text-muted-foreground">
          {row.score !== null && (
            <span className="inline-grid h-[17px] min-w-[23px] place-items-center rounded-[3px] bg-brand-navy px-1 text-[8px] font-bold text-primary-foreground tabular-nums">
              {row.score}
            </span>
          )}
          {row.badge && (
            <span className="font-bold uppercase tracking-[0.04em] text-brand-blue">{row.badge}</span>
          )}
          {row.source && <b className="font-semibold text-foreground/80">{row.source}</b>}
          {row.timestamp && <span>{compact ? relTime(row.timestamp) : shortDate(row.timestamp)}</span>}
          {row.matterLabel && row.matterLabel !== row.source && (
            <span className="text-brand-navy/70">{row.matterLabel}</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => onSelect(row)}
          className={[
            "mt-1 block w-full text-left font-semibold leading-[1.24] text-foreground hover:text-brand-blue",
            compact ? "line-clamp-3 text-[12px]" : isDoc ? "text-[13px]" : "text-[14.5px]",
          ].join(" ")}
        >
          {row.title}
        </button>

        {!compact && row.detail && (
          <p className="mt-1 line-clamp-3 text-[11.5px] leading-[1.45] text-muted-foreground">
            {row.detail}
          </p>
        )}

        {!compact && row.bullets.length > 0 && (
          <ul className="mt-1.5 space-y-[3px] border-t border-border/60 pt-1.5">
            {row.bullets.slice(0, 6).map((b) => (
              <li
                key={b}
                className="relative pl-3 text-[10.8px] leading-[1.42] text-foreground/75 before:absolute before:left-0 before:top-[6px] before:h-[3px] before:w-[3px] before:rounded-full before:bg-brand-orange"
              >
                {b}
              </li>
            ))}
          </ul>
        )}

        {!compact && row.analysis && (
          <p className="mt-1.5 text-[10.5px] leading-[1.45] text-muted-foreground">
            <b className="mr-1.5 font-semibold uppercase tracking-[0.05em] text-brand-navy">
              Why it matters
            </b>
            {row.analysis}
          </p>
        )}

        {!compact && row.meta.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground">
            {row.meta.slice(0, 6).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onTopic(m)}
                className="rounded border border-border/70 bg-muted/50 px-1.5 py-[1px] text-brand-navy/80 hover:bg-brand-blue-soft"
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {!compact && (
        <div className="hidden flex-col items-end gap-1.5 sm:flex">
          <span
            className={`text-[8px] font-semibold uppercase tracking-[0.05em] ${PRIORITY_CLASS[row.priority]}`}
          >
            {PRIORITY_LABEL[row.priority]}
          </span>
          <button
            type="button"
            onClick={() => onSelect(row)}
            title="Open briefing"
            className="grid h-[26px] w-[29px] place-items-center rounded-[3px] border border-border/80 bg-card text-brand-navy/70 hover:bg-brand-blue-soft hover:text-brand-navy"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          {row.url && (
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              title="Open source"
              className="grid h-[26px] w-[29px] place-items-center rounded-[3px] border border-border/80 bg-card text-brand-navy/70 hover:bg-brand-blue-soft hover:text-brand-navy"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
