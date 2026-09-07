import {
  Check,
  ChevronDown,
  FileText,
  Globe,
  Loader2,
  Monitor,
  Search,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { agentMeta, toolLabel, type Round } from "@/lib/chat-types";
import { summarizeResearchActivity } from "@/lib/agents/research-activity";

function elapsed(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1_000) return "<1s";
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function iconFor(tool: string) {
  if (tool === "fetch_page") return Globe;
  if (tool === "run_python") return Terminal;
  if (tool === "browser_task") return Monitor;
  if (tool === "db_read_filing") return FileText;
  return Search;
}

export function ResearchActivity({
  rounds,
  sourceCount,
  settled,
}: {
  rounds: Round[];
  sourceCount: number;
  settled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeResearchActivity(rounds, settled), [rounds, settled]);

  useEffect(() => {
    if (settled) setOpen(false);
  }, [settled]);

  if (!rounds.length) return null;

  return (
    <section className="mb-3 mt-1.5 border-y border-border/70 bg-slate-50/45">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {settled ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-700" strokeWidth={2.5} />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 text-brand-orange motion-safe:animate-spin" />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
            settled ? "text-foreground/75" : "wr-shimmer"
          }`}
        >
          {summary.phase}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
          {summary.tools} action{summary.tools === 1 ? "" : "s"}
          {elapsed(summary.elapsedMs) ? ` · ${elapsed(summary.elapsedMs)}` : ""}
          {sourceCount ? ` · ${sourceCount} source${sourceCount === 1 ? "" : "s"}` : ""}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <ol className="border-t border-border/70 px-3 py-2">
          {rounds.map((round) => (
            <li key={round.round} className="border-b border-border/60 py-2 last:border-b-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11.5px] font-semibold text-foreground/80">
                  {round.phase?.trim() || `Research phase ${round.round}`}
                </p>
                <span className="text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
                  {round.done || settled ? "Complete" : "In progress"}
                </span>
              </div>
              <div className="mt-1.5 divide-y divide-border/50 border-l border-border pl-3">
                {Object.values(round.agents).map((agent) => {
                  const meta = agentMeta(agent.agent);
                  return (
                    <details key={agent.agent} className="group py-1.5">
                      <summary className="flex cursor-pointer list-none items-baseline gap-2">
                        <span className={`shrink-0 text-[11px] font-medium ${meta.color}`}>
                          {meta.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
                          {agent.focus}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {agent.tools.length}
                        </span>
                      </summary>
                      {agent.tools.length ? (
                        <ul className="mt-1 space-y-0.5">
                          {agent.tools.map((tool, index) => {
                            const Icon = iconFor(tool.tool);
                            return (
                              <li
                                key={tool.id ?? `${tool.tool}-${index}`}
                                className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground"
                              >
                                <Icon className="h-3 w-3 shrink-0" />
                                <span className="shrink-0">{toolLabel(tool.tool, tool.scope)}</span>
                                {tool.query ? (
                                  <span className="min-w-0 flex-1 truncate">{tool.query}</span>
                                ) : null}
                                {typeof tool.hits === "number" ? (
                                  <span className="shrink-0 tabular-nums">{tool.hits}</span>
                                ) : (
                                  <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" />
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </details>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
