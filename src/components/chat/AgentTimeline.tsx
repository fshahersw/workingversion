import { AnimatePresence, motion, LayoutGroup } from "framer-motion";
import {
  Check,
  ChevronDown,
  Loader2,
  Scale,
  FileText,
  ShieldAlert,
  Microscope,
  Newspaper,
  Globe,
  Gavel,
  Terminal,
  Monitor,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { agentMeta, toolLabel, type AgentRun, type Round } from "@/lib/chat-types";

const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;
const EASE_INOUT = [0.65, 0, 0.35, 1] as const;

/** A distinct icon per research tool, so the timeline reads at a glance. */
const TOOL_ICON: Record<string, LucideIcon> = {
  search_case_law: Scale,
  search_authorities: Scale,
  search_judicial_parties: Scale,
  search_regulatory_text: FileText,
  search_enforcement_history: ShieldAlert,
  search_scientific_literature: Microscope,
  search_technical_environmental: FileText,
  search_legal_news: Newspaper,
  fetch_page: Globe,
  recap_read: FileText,
  recap_search: Search,
  recap_docket: Gavel,
  db_find_case: Search,
  db_docket_sheet: Gavel,
  db_read_filing: FileText,
  db_search_filings: Search,
  db_get_case: Gavel,
  db_calendar: Gavel,
  db_graph_ask: Gavel,
  run_python: Terminal,
  browser_task: Monitor,
};
function toolIcon(tool: string): LucideIcon {
  return TOOL_ICON[tool] ?? Search;
}

export function AgentTimeline({
  rounds,
  collapsed,
  sourceCount,
  settled,
}: {
  rounds: Round[];
  collapsed: boolean;
  sourceCount: number;
  /** True once the writer has started/finished — no live shimmer anywhere. */
  settled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const totalAgents = rounds.reduce(
    (n, r) => n + Object.keys(r.agents).length,
    0,
  );

  return (
    <div className="mb-3 mt-1.5">
      <AnimatePresence mode="wait" initial={false}>
        {collapsed ? (
          <motion.div
            key="pill"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.28, ease: EASE_INOUT }}
          >
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="group -ml-1 inline-flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-muted-foreground/70 transition-colors duration-200 hover:text-foreground/80"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-brand-navy/30 transition-colors group-hover:bg-brand-navy/50" />
              {sourceCount} source{sourceCount === 1 ? "" : "s"} ·{" "}
              {rounds.length} round{rounds.length === 1 ? "" : "s"} ·{" "}
              {totalAgents} agent{totalAgents === 1 ? "" : "s"}
              <ChevronDown
                className={`h-3 w-3 opacity-50 transition-all duration-300 group-hover:opacity-80 ${open ? "rotate-180" : ""}`}
              />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  key="reasoning"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.38, ease: EASE_INOUT }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 rounded-lg bg-muted/25 px-2.5 py-2.5">
                    <TimelineInner rounds={rounds} settled={settled} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="live"
            initial={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.42, ease: EASE_INOUT }}
            className="overflow-x-hidden rounded-lg bg-muted/25 px-2.5 py-2.5"
          >
            <TimelineInner rounds={rounds} live={!settled} settled={settled} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


// Rail geometry. The vertical line runs down the center of the badge column.
const GUTTER = 22; // px – fixed node column width
const LINE_LEFT = 10.5; // px – center of the node column

function TimelineInner({
  rounds,
  live,
  settled,
}: {
  rounds: Round[];
  live?: boolean;
  settled?: boolean;
}) {
  return (
    <LayoutGroup>
      <div className="relative">
        <div
          className="absolute bottom-2 top-2 w-px bg-gradient-to-b from-border/0 via-border to-border/0"
          style={{ left: LINE_LEFT }}
        />
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {rounds.map((r, ri) => (
              <motion.div
                key={r.round}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE_OUT, delay: ri * 0.03 }}
                className="relative"
              >
                {/* Phase row */}
                <div className="flex items-center gap-2">
                  <div
                    className="flex shrink-0 justify-center"
                    style={{ width: GUTTER }}
                  >
                    <span
                      className={`h-[7px] w-[7px] rounded-full ring-[3px] ring-background ${
                        r.done ? "bg-brand-navy/30" : "bg-brand-orange"
                      }`}
                    />
                  </div>
                  <span
                    className={
                      r.done || settled
                        ? "text-[12px] font-medium tracking-tight text-foreground/70"
                        : "wr-shimmer text-[12px] font-medium tracking-tight"
                    }
                  >
                    {r.phase?.trim() ||
                      (r.round === 1 ? "Reviewing the question" : `Round ${r.round}`)}
                  </span>
                </div>

                {/* Subagent rows */}
                <div className="mt-1 space-y-1">
                  <AnimatePresence initial={false}>
                    {Object.values(r.agents).map((a, idx) => (
                      <AgentRow
                        key={a.agent}
                        a={a}
                        idx={idx}
                        settled={settled}
                        showFocus={Object.keys(r.agents).length > 1}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {live && !settled && rounds.length === 0 && (
            <div className="flex items-center gap-2">
              <div
                className="flex shrink-0 justify-center"
                style={{ width: GUTTER }}
              >
                <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-brand-orange ring-[3px] ring-background" />
              </div>
            </div>
          )}
        </div>
      </div>
    </LayoutGroup>
  );
}

function AgentRow({
  a,
  idx,
  settled,
  showFocus,
}: {
  a: AgentRun;
  idx: number;
  settled?: boolean;
  /** Show the agent's focus line — only useful when a round has several agents. */
  showFocus?: boolean;
}) {
  const m = agentMeta(a.agent);
  const dotColor = m.color.replace("text-", "bg-");
  const running = !settled && a.status !== "done";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.26, ease: EASE_OUT, delay: idx * 0.04 }}
      className="flex items-start gap-2"
    >
      <div
        className="flex shrink-0 justify-center pt-[5px]"
        style={{ width: GUTTER }}
      >
        <div className="relative grid h-[11px] w-[11px] place-items-center">
          {a.status === "done" ? (
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 380, damping: 24 }}
              className={`z-[1] grid h-[11px] w-[11px] place-items-center rounded-full opacity-80 ring-[3px] ring-background ${dotColor}`}
            >
              <Check className="h-[7px] w-[7px] text-white" strokeWidth={4} />
            </motion.div>
          ) : (
            <>
              {!settled && (
                <span
                  className={`absolute inline-flex h-[11px] w-[11px] animate-ping rounded-full opacity-30 ${dotColor}`}
                />
              )}
              <span
                className={`relative z-[1] inline-flex h-[8px] w-[8px] rounded-full ring-[3px] ring-background ${dotColor}`}
              />
            </>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            className={
              running
                ? "wr-shimmer text-[11.5px] font-medium"
                : `text-[11.5px] font-medium ${m.color} opacity-80`
            }
          >
            {m.name}
          </span>
          {showFocus && a.focus && (
            <span
              className="min-w-0 truncate text-[10.5px] text-muted-foreground/60"
              title={a.focus}
            >
              {a.focus}
            </span>
          )}
          {typeof a.count === "number" && a.count > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              · {a.count} source{a.count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {/* Per-call activity: each tool call is its own row — icon, plain-English
            label, the query it ran, and a running -> resolved state (spinner until
            its hit count lands). The reducer upserts by tool-use id, so a call's
            start and completion are one row that fills in. This is the timeline the
            attorney watches work. */}
        {a.tools.length > 0 && (
          <ul className="wr-app-scroll mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1">
            {a.tools.map((t, i) => {
              const Icon = toolIcon(t.tool);
              const done = typeof t.hits === "number";
              return (
                <li
                  key={t.id ?? i}
                  className="flex items-baseline gap-1.5 text-[10.5px] leading-snug"
                >
                  <Icon
                    className="h-3 w-3 shrink-0 translate-y-[1.5px] text-muted-foreground/50"
                    strokeWidth={1.9}
                  />
                  <span className="shrink-0 text-muted-foreground/60">
                    {toolLabel(t.tool, t.scope)}
                  </span>
                  {t.query && (
                    <span
                      className="min-w-0 flex-1 truncate italic text-muted-foreground/45"
                      title={t.query}
                    >
                      {t.query}
                    </span>
                  )}
                  {done ? (
                    (t.hits ?? 0) > 0 ? (
                      <span className="shrink-0 tabular-nums text-muted-foreground/50">
                        {t.hits}
                      </span>
                    ) : (
                      <Check className="h-3 w-3 shrink-0 text-muted-foreground/50" strokeWidth={3} />
                    )
                  ) : running ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand-orange/70" strokeWidth={2} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </motion.div>
  );
}
