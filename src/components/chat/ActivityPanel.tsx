import {
  Check,
  ChevronDown,
  FileOutput,
  FileText,
  Globe,
  Loader2,
  Search,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { summarizeResearchActivity } from "@/lib/agents/research-activity";
import { toolLabel, type Message, type ToolCall } from "@/lib/chat-types";

/**
 * One quiet panel for what the agent does before the answer: the live status
 * line and the tool calls as they start and fill in. Open while the agent
 * works, folds to a single summary line the moment the answer starts, and stays
 * available as a trace afterwards. Raw model reasoning is never shown.
 */
export function ActivityPanel({ msg }: { msg: Message }) {
  const running = msg.status === "thinking";
  const writing = msg.status === "writing";
  const settled = writing || msg.status === "done";
  const [open, setOpen] = useState(true);
  const [pinned, setPinned] = useState(false);

  // Fold automatically when the answer starts unless the reader opened it by hand.
  useEffect(() => {
    if (settled && !pinned) setOpen(false);
  }, [settled, pinned]);

  const steps = useMemo<ToolCall[]>(
    () =>
      msg.rounds.flatMap((round) => Object.values(round.agents).flatMap((agent) => agent.tools)),
    [msg.rounds],
  );
  // Narration lines with arrival times; a reopened message only has the joined
  // text, so those lines sort ahead of the tool rows.
  const narration = useMemo<{ text: string; at: number }[]>(() => {
    if (msg.narration?.length) return msg.narration;
    return (msg.thinking ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ text, at: 0 }));
  }, [msg.narration, msg.thinking]);
  const timeline = useMemo(() => buildTimeline(narration, steps), [narration, steps]);
  const summary = useMemo(
    () => summarizeResearchActivity(msg.rounds, settled),
    [msg.rounds, settled],
  );
  const sourceCount = msg.sources?.length ?? 0;
  const pending = steps.filter((step) => typeof step.hits !== "number").length;

  if (!steps.length && !narration.length && !running) return null;
  if (msg.mode === "conversational") return null;

  const title = running
    ? (narration[narration.length - 1]?.text ??
      (steps.length ? "Working the record" : "Reading the question"))
    : writing
      ? msg.deliverable
        ? `Preparing your ${msg.deliverable.toUpperCase()}`
        : "Writing the answer"
      : `Researched ${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  const meta = [
    steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : null,
    running && pending ? `${pending} running` : null,
    settled && elapsed(summary.elapsedMs) ? elapsed(summary.elapsedMs) : null,
    msg.mode && msg.mode !== "conversational" && settled ? modeLabel(msg.mode) : null,
  ].filter(Boolean);

  const showBody = open && timeline.length > 0;

  return (
    <section className="mb-3 overflow-hidden rounded-md border border-border/80 bg-surface">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setPinned(true);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StatusMark running={running} writing={writing} />
        <span
          className={`min-w-0 flex-1 text-[12.5px] leading-snug ${
            running ? "wr-shimmer font-medium" : "font-medium text-foreground/80"
          }`}
        >
          {title}
        </span>
        {meta.length > 0 && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
            {meta.join(" · ")}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {showBody ? (
        <div className="border-t border-border/60">
          <Timeline items={timeline} live={running} />
        </div>
      ) : null}
    </section>
  );
}

type TimelineItem =
  | { kind: "note"; text: string; at: number }
  | { kind: "tool"; call: ToolCall; at: number };

/** Merge narration and tool calls by arrival, notes first on a tie, so each
 *  "why" line sits above the calls it explains. */
function buildTimeline(
  narration: { text: string; at: number }[],
  steps: ToolCall[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...narration.map((n) => ({ kind: "note" as const, text: n.text, at: n.at })),
    ...steps.map((call, index) => ({
      kind: "tool" as const,
      call,
      at: call.at ?? Number.MAX_SAFE_INTEGER - steps.length + index,
    })),
  ];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.at !== b.item.at) return a.item.at - b.item.at;
      if (a.item.kind !== b.item.kind) return a.item.kind === "note" ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function StatusMark({ running, writing }: { running: boolean; writing: boolean }) {
  if (running) {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 text-brand-orange motion-safe:animate-spin" />;
  }
  if (writing) {
    return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-orange" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-700" strokeWidth={2.5} />;
}

function Timeline({ items, live }: { items: TimelineItem[]; live: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the newest entry in view while the agent is still working.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !live) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, live]);

  return (
    <ol ref={listRef} className="wr-app-scroll max-h-64 overflow-y-auto px-2.5 py-1.5">
      {items.map((item, index) => {
        if (item.kind === "note") {
          return (
            <li
              key={`note-${index}`}
              className={`py-[3px] text-[12px] leading-snug text-foreground/70 ${index > 0 ? "mt-1" : ""}`}
            >
              {item.text}
            </li>
          );
        }
        const { call } = item;
        const Icon = iconFor(call.tool);
        const done = typeof call.hits === "number";
        return (
          <li
            key={call.id ?? `tool-${index}`}
            className="flex items-center gap-2 py-[3px] pl-3 text-[12px] leading-snug"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.9} />
            <span className="shrink-0 font-medium text-foreground/80">
              {toolLabel(call.tool, call.scope)}
            </span>
            {call.query ? (
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={call.query}>
                {call.query}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {done ? (
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                {resultLabel(call.tool, call.hits ?? 0)}
              </span>
            ) : (
              <Loader2 className="h-3 w-3 shrink-0 text-brand-orange motion-safe:animate-spin" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function iconFor(tool: string) {
  if (tool === "fetch_page") return Globe;
  if (tool === "run_python") return Terminal;
  if (tool === "create_document") return FileOutput;
  if (tool === "read_document" || tool === "db_read_filing")
    return FileText;
  return Search;
}

function resultLabel(tool: string, hits: number): string {
  if (tool === "run_python") return hits ? "ran" : "no output";
  if (tool === "create_document") return hits ? "file ready" : "failed";
  if (tool === "fetch_page" || tool === "db_read_filing") {
    return hits ? "read" : "no text";
  }
  if (tool === "verify_citations") return hits ? `${hits} checked` : "none found";
  return hits ? `${hits} result${hits === 1 ? "" : "s"}` : "no results";
}

function modeLabel(mode: string): string {
  if (mode === "fast") return "Fast";
  if (mode === "think") return "Think";
  return mode;
}

function elapsed(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 1_000) return "<1s";
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
