import {
  AlertTriangle,
  BookCheck,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  FileOutput,
  FileText,
  FlaskConical,
  Gavel,
  Globe,
  Landmark,
  Loader2,
  Microscope,
  Pill,
  Search,
  Share2,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { summarizeResearchActivity } from "@/lib/agents/research-activity";
import { toolLabel, type Message, type ToolCall } from "@/lib/chat-types";
import { Favicon } from "./Favicon";

/**
 * What the agent does before (and while) it writes: the live status line, then
 * the work grouped into steps. Each step is one narration line ("Pulling the
 * latest CMO and checking the state track") with the tool calls it triggered
 * nested under it, each call showing what it searched, the sites it came back
 * with, how many results, and how long it took. Open while the agent works,
 * folds to one summary line when the answer starts, stays available as a
 * trace, and closes with the verification tally. Raw model reasoning is never
 * shown.
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
  // ...and unfold when the same message goes back to work (the attorney
  // answered its clarifying question and the run resumed on it).
  useEffect(() => {
    if (running && !pinned) setOpen(true);
  }, [running, pinned]);

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
  const groups = useMemo(() => buildGroups(narration, steps), [narration, steps]);
  const summary = useMemo(
    () => summarizeResearchActivity(msg.rounds, settled),
    [msg.rounds, settled],
  );
  const sourceCount = msg.sources?.length ?? 0;
  const pending = steps.filter((step) => !isSettled(step)).length;
  // The message is over (finished, stopped, or failed): calls that never
  // reported back are shown as stopped rather than still running.
  const finished = msg.status === "done" || msg.status === "error";
  const verification = msg.status === "done" ? msg.verification : undefined;
  const verificationTone = verification ? verificationToneOf(verification) : null;
  // Either tally earns the row: the verbatim-specifics check, or the
  // faithfulness verdict on its own when there were no specifics to check.
  const verdict = verification ? verdictTally(verification) : null;

  if (msg.mode === "conversational") return null;
  if (!steps.length && !narration.length && !running && !writing && !verdict) return null;

  const title = running
    ? (narration[narration.length - 1]?.text ??
      (steps.length ? "Working the record" : "Reading the question"))
    : writing
      ? msg.deliverable
        ? `Preparing your ${msg.deliverable.toUpperCase()}`
        : msg.answer.trim()
          ? "Writing the answer"
          : `Composing from ${sourceCount} source${sourceCount === 1 ? "" : "s"}`
      : `Researched ${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  const meta = [
    steps.length ? `${steps.length} ${steps.length === 1 ? "call" : "calls"}` : null,
    running && pending ? `${pending} running` : null,
    settled && elapsed(summary.elapsedMs) ? elapsed(summary.elapsedMs) : null,
  ].filter(Boolean);

  const showBody = open && (groups.length > 0 || verdict !== null);

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
          className={`min-w-0 flex-1 truncate text-[13px] leading-snug ${
            running || (writing && !msg.answer.trim())
              ? "wr-shimmer font-medium"
              : "font-medium text-foreground/80"
          }`}
        >
          {title}
        </span>
        {msg.mode && msg.mode !== "conversational" && (
          <span
            className="shrink-0 rounded-[4px] border border-border/70 bg-card px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em] text-brand-navy/70"
            title={msg.modeReason ? `${modeLabel(msg.mode)}: ${msg.modeReason}` : modeLabel(msg.mode)}
          >
            {modeLabel(msg.mode)}
          </span>
        )}
        {verdict && verificationTone && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums ${
              verificationTone === "clean" ? "text-emerald-700/80" : "text-amber-700/80"
            }`}
            title={verdict.title}
          >
            <ShieldCheck className="h-3 w-3" strokeWidth={2.2} />
            {verdict.text}
          </span>
        )}
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
          <Timeline
            groups={groups}
            live={running}
            finished={finished}
            verification={verdict ? verification : undefined}
          />
        </div>
      ) : null}
    </section>
  );
}

type StepGroup = {
  /** The narration line that opened this step, if any. */
  note: string | null;
  at: number;
  calls: ToolCall[];
};

/** Group tool calls under the narration line that preceded them (by arrival).
 *  Calls that arrive before any narration form an unlabeled leading step. */
function buildGroups(narration: { text: string; at: number }[], steps: ToolCall[]): StepGroup[] {
  // A conversation stored before narration carried timestamps has notes with
  // no arrival time at all: they cannot be placed among the calls (sorting
  // would put every note first and stack every call under the last one), so
  // the trace is one flat step instead.
  if (steps.length && narration.length && narration.every((n) => !(n.at > 0))) {
    return [{ note: null, at: 0, calls: steps }];
  }
  type Item =
    | { kind: "note"; text: string; at: number; index: number }
    | { kind: "tool"; call: ToolCall; at: number; index: number };
  const items: Item[] = [
    ...narration.map((n, index) => ({ kind: "note" as const, text: n.text, at: n.at, index })),
    ...steps.map((call, index) => ({
      kind: "tool" as const,
      call,
      at: call.at ?? Number.MAX_SAFE_INTEGER - steps.length + index,
      index,
    })),
  ];
  items.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.kind !== b.kind) return a.kind === "note" ? -1 : 1;
    return a.index - b.index;
  });
  const groups: StepGroup[] = [];
  for (const item of items) {
    if (item.kind === "note") {
      groups.push({ note: item.text, at: item.at, calls: [] });
      continue;
    }
    let last = groups[groups.length - 1];
    if (!last) {
      last = { note: null, at: item.at, calls: [] };
      groups.push(last);
    }
    last.calls.push(item.call);
  }
  return groups;
}

function isSettled(call: ToolCall): boolean {
  return typeof call.hits === "number" || Boolean(call.error);
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

function Timeline({
  groups,
  live,
  finished,
  verification,
}: {
  groups: StepGroup[];
  /** The agent is still researching (keeps the newest row in view). */
  live: boolean;
  /** The message is over; rows that never settled render as stopped. */
  finished: boolean;
  /** Already gated by the caller: present only when there is a tally to show. */
  verification: Message["verification"] | undefined;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const total = groups.reduce((n, g) => n + g.calls.length, 0);
  // Keep the newest entry in view while the agent is still working.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !live) return;
    el.scrollTop = el.scrollHeight;
  }, [total, groups.length, live]);

  return (
    <ol ref={listRef} className="wr-app-scroll max-h-72 overflow-y-auto px-2.5 py-2">
      {groups.map((group, gi) => {
        const done = group.calls.length > 0 && (finished || group.calls.every(isSettled));
        const sources = group.calls.reduce((n, c) => n + (c.error ? 0 : (c.hits ?? 0)), 0);
        return (
          <li key={`step-${gi}`} className={gi > 0 ? "mt-2" : ""}>
            <div className="flex items-start gap-2">
              <span
                className={`mt-[3px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full text-[9px] font-semibold tabular-nums ${
                  done || !live
                    ? "bg-brand-navy/10 text-brand-navy/80"
                    : "bg-brand-orange/15 text-brand-orange"
                }`}
              >
                {gi + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground/80">
                    {group.note ?? (group.calls.length ? "Searching the record" : "")}
                  </span>
                  {done && group.calls.length > 1 && (
                    <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
                      {group.calls.length} calls · {sources} result{sources === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                {group.calls.length > 0 && (
                  <ul className="mt-1 space-y-[3px] border-l border-border/60 pl-2.5">
                    {group.calls.map((call, ci) => (
                      <ToolRow key={call.id ?? `tool-${gi}-${ci}`} call={call} finished={finished} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </li>
        );
      })}
      {verification && (
        <li className={groups.length ? "mt-2" : ""}>
          <VerificationRow v={verification} />
        </li>
      )}
    </ol>
  );
}

function ToolRow({ call, finished }: { call: ToolCall; finished: boolean }) {
  const Icon = iconFor(call.tool);
  const settled = isSettled(call);
  const failed = Boolean(call.error);
  // Never reported back and the message is over (Stop, an error, or the loop
  // moved on without a completion): a stopped row, not a spinner forever.
  const stopped = !settled && finished;
  return (
    <li
      className={`flex items-center gap-2 py-px text-[12px] leading-snug ${
        stopped ? "text-muted-foreground/70" : ""
      }`}
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-amber-600/80" : "text-muted-foreground"}`}
        strokeWidth={1.9}
      />
      <span className={`shrink-0 font-medium ${stopped ? "text-foreground/55" : "text-foreground/80"}`}>
        {toolLabel(call.tool, call.scope)}
      </span>
      {call.query ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={call.query}>
          {call.query}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {call.hosts && call.hosts.length > 0 && !failed && (
        <span className="flex shrink-0 items-center -space-x-1" aria-label={call.hosts.join(", ")}>
          {call.hosts.slice(0, 3).map((h) => (
            <Favicon key={h} host={h} size={14} className="ring-2 ring-surface" />
          ))}
        </span>
      )}
      {settled ? (
        <span
          className={`inline-flex shrink-0 items-center gap-1 tabular-nums text-[11px] ${
            failed ? "text-amber-700/80" : "text-muted-foreground"
          }`}
        >
          {failed && <AlertTriangle className="h-3 w-3" strokeWidth={2} />}
          {failed ? (call.error === "timeout" ? "timed out" : "failed") : resultLabel(call.tool, call.hits ?? 0)}
          {typeof call.ms === "number" && call.ms > 0 && (
            <span className="text-muted-foreground/60">· {elapsed(call.ms)}</span>
          )}
        </span>
      ) : stopped ? (
        <span
          className="shrink-0 text-[11px] text-muted-foreground/60"
          title="This call had not finished when the run ended"
        >
          — stopped
        </span>
      ) : (
        <Loader2 className="h-3 w-3 shrink-0 text-brand-orange motion-safe:animate-spin" />
      )}
    </li>
  );
}

function VerificationRow({ v }: { v: NonNullable<Message["verification"]> }) {
  const tone = verificationToneOf(v);
  const open = v.unverified.length + v.orphanRefs.length;
  const faith = v.faithfulness;
  const detail = [
    ...v.unverified,
    ...v.orphanRefs.map((r) => `unmatched ${r}`),
    ...(faith?.unsupported ?? []).map((u) => `not fully supported: ${u.claim}`),
  ].join("\n");
  return (
    <div className="flex items-start gap-2" title={detail || undefined}>
      <span
        className={`mt-[2px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full ${
          tone === "clean" ? "bg-emerald-600/12 text-emerald-700" : "bg-amber-500/15 text-amber-700"
        }`}
      >
        <ShieldCheck className="h-[10px] w-[10px]" strokeWidth={2.4} />
      </span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground/80">
        {v.factsChecked > 0 ? (
          <span className="tabular-nums">
            Verified {v.factsVerified}/{v.factsChecked} specifics against the sources
          </span>
        ) : (
          // Faithfulness-only verdict: nothing verbatim to count, so no "0/0".
          <span>Checked the answer against its sources</span>
        )}
        {open > 0 && (
          <span className="text-amber-700/80">
            {" "}
            · {open} to confirm
          </span>
        )}
        {faith && faith.checked > 0 && (
          <span className={faith.unsupported.length ? "text-amber-700/80" : "text-muted-foreground"}>
            {" "}
            · {faith.supported}/{faith.checked} cited claims source-supported
          </span>
        )}
      </div>
    </div>
  );
}

function verificationToneOf(v: NonNullable<Message["verification"]>): "clean" | "review" {
  const open = v.unverified.length + v.orphanRefs.length + (v.faithfulness?.unsupported.length ?? 0);
  return open === 0 ? "clean" : "review";
}

/** The one-glance tally for the collapsed header, or null when neither check
 *  had anything to count (then there is no verification to show at all). */
function verdictTally(
  v: NonNullable<Message["verification"]>,
): { text: string; title: string } | null {
  if (v.factsChecked > 0) {
    return {
      text: `${v.factsVerified}/${v.factsChecked} verified`,
      title:
        "Specifics in the answer (dates, docket and MDL numbers, figures, citations) found verbatim in the retrieved sources",
    };
  }
  const faith = v.faithfulness;
  if (faith && faith.checked > 0) {
    return {
      text: `${faith.supported}/${faith.checked} supported`,
      title: "Cited claims in the answer that their cited sources actually support",
    };
  }
  return null;
}

function iconFor(tool: string): LucideIcon {
  if (tool === "fetch_page") return Globe;
  if (tool === "run_python") return Terminal;
  if (tool === "create_document") return FileOutput;
  if (tool === "read_document" || tool === "db_read_filing") return FileText;
  if (tool === "verify_citations") return BookCheck;
  if (tool === "db_calendar") return CalendarDays;
  if (tool === "db_graph_ask") return Share2;
  if (tool.startsWith("db_")) return Gavel;
  if (tool === "fda_search") return Pill;
  if (tool === "federal_register_search" || tool === "ecfr_search") return Landmark;
  if (tool === "sec_search") return Building2;
  if (tool === "search_pubmed") return FlaskConical;
  if (tool === "clinicaltrials_search") return Microscope;
  return Search;
}

function resultLabel(tool: string, hits: number): string {
  if (tool === "run_python") return hits ? "ran" : "no output";
  if (tool === "create_document") return hits ? "file ready" : "failed";
  if (tool === "fetch_page" || tool === "db_read_filing" || tool === "read_document") {
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
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
