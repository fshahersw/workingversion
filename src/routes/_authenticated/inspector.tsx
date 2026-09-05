// Run Inspector — dev observability surface. Polls /api/traces (the in-memory
// ring tapped from agentLog) and renders a live per-run timeline: mode routing,
// each agent step's latency + token cache, tool calls, the coverage gate, and
// the verification + faithfulness verdicts. Watch any real app/eval run
// decompose without reading server logs. Reachable at /inspector.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Activity, CircleDot } from "lucide-react";

import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/inspector")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Run Inspector — Seeger Weiss Platform" },
      {
        name: "description",
        content:
          "Live observability for the litigation research agent: per-run timeline of mode routing, tool calls, token cache, coverage gate, and citation-faithfulness verdicts.",
      },
    ],
  }),
  component: InspectorPage,
});

// --- Types (mirror trace.server.ts; kept local so no server module is bundled) ---
type RunStatus = "running" | "complete" | "error";
type RunSummary = {
  run: string;
  startedAt: number;
  engine?: string;
  mode?: string;
  status: RunStatus;
  query?: string;
  totalMs?: number;
  steps?: number;
  toolCalls?: number;
  sources?: number;
  answerChars?: number;
  gateRequeried?: boolean;
  tokens?: { in: number; out: number; total: number };
  faith?: { checked: number; supported: number; unsupported: number };
  verify?: { checked: number; verified: number };
  error?: string;
  events: number;
};
type TraceEvent = { at: number; stage: string; level: "log" | "error"; fields: Record<string, unknown> };
type RunTrace = { run: string; startedAt: number; events: TraceEvent[] };

const POLL_MS = 2500;

function ms(n?: number): string {
  if (n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}
function tok(n?: number): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fld(f: Record<string, unknown>, k: string): string | undefined {
  const v = f[k];
  return v === undefined || v === null ? undefined : String(v);
}

function statusTone(s: RunStatus): string {
  if (s === "complete") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (s === "error") return "text-red-700 bg-red-50 border-red-200";
  return "text-brand-orange bg-amber-50 border-amber-200";
}
function modeTone(m?: string): string {
  if (m === "think") return "text-violet-700 bg-violet-50 border-violet-200";
  if (m === "fast") return "text-sky-700 bg-sky-50 border-sky-200";
  if (m === "conversational") return "text-slate-600 bg-slate-100 border-slate-200";
  return "text-slate-600 bg-slate-50 border-slate-200";
}

/** A compact, human one-liner for a timeline event. */
function describe(e: TraceEvent): { title: string; detail?: string; tone?: string } {
  const f = e.fields;
  switch (e.stage) {
    case "run_start":
      return { title: "Run start", detail: `${fld(f, "mode") ?? "?"} · ${fld(f, "engine") ?? ""}`.trim() };
    case "agent_step": {
      const cr = fld(f, "cache_read");
      const cw = fld(f, "cache_write");
      const calls = fld(f, "calls");
      const stop = fld(f, "stop");
      const bits = [
        `step ${fld(f, "step") ?? "?"}`,
        ms(Number(fld(f, "ms"))),
        stop ? `→ ${stop}` : "",
      ].filter(Boolean);
      const inTok = fld(f, "in");
      const outTok = fld(f, "out");
      const detail = [
        calls && calls !== "-" ? `tools: ${calls}` : "no tool calls",
        inTok || outTok ? `tok ${tok(Number(inTok ?? 0))} in / ${tok(Number(outTok ?? 0))} out` : "",
        cr || cw ? `cache r${cr ?? 0}/w${cw ?? 0}` : "",
      ].filter(Boolean).join("  ·  ");
      return { title: bits.join("  "), detail };
    }
    case "coverage_check": {
      const covered = fld(f, "covered") === "true";
      return {
        title: "Coverage gate",
        detail: covered ? "covered ✓" : `gap: ${fld(f, "missing")} missing · ${fld(f, "sources")} src`,
        tone: covered ? "text-emerald-700" : "text-amber-700",
      };
    }
    case "coverage_gap":
      return { title: "Coverage re-query", detail: fld(f, "queries"), tone: "text-amber-700" };
    case "writer_start":
      return { title: "Synthesis start", detail: `${fld(f, "sources") ?? "?"} sources` };
    case "research_loop":
      return {
        title: "Research loop done",
        detail: `${fld(f, "steps")} steps · ${fld(f, "tool_calls")} calls · ${fld(f, "hits")} hits · ${fld(f, "sources")} src · ${fld(f, "answer_chars")} chars · ${tok(Number(fld(f, "tokens_total")))} tok · gate ${fld(f, "gate_requeried") === "true" ? "re-queried" : "ok"}`,
      };
    case "faithfulness": {
      const flagged = fld(f, "flagged");
      return {
        title: `Faithfulness · ${fld(f, "model")}`,
        detail: `${fld(f, "evaluated")}/${fld(f, "claims")} claims · ${ms(Number(fld(f, "ms")))}${flagged ? ` · flagged: ${flagged}` : ""}`,
        tone: flagged ? "text-amber-700" : "text-emerald-700",
      };
    }
    case "verification": {
      const faithC = fld(f, "faith_checked");
      const parts = [
        `facts ${fld(f, "facts_verified") ?? 0}/${fld(f, "facts_checked") ?? 0}`,
        faithC ? `faithful ${fld(f, "faith_supported") ?? 0}/${faithC}` : "",
        `orphan refs ${fld(f, "orphan_refs") ?? 0}`,
      ].filter(Boolean);
      return { title: "Verification", detail: parts.join("  ·  ") };
    }
    case "run_done":
      return {
        title: "Run complete",
        detail: `${fld(f, "status")} · ${ms(Number(fld(f, "total_ms")))} · ${fld(f, "sources")} src · ${tok(Number(fld(f, "tokens_total")))} tok`,
        tone: "text-emerald-700",
      };
    case "run_failed":
    case "no_answer":
    case "research_loop_failed":
      return { title: e.stage, detail: fld(f, "error"), tone: "text-red-700" };
    default: {
      const detail = Object.entries(f)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join("  ·  ");
      return { title: e.stage, detail: detail || undefined };
    }
  }
}

function InspectorPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [auto, setAuto] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = selected;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/traces");
      if (!res.ok) throw new Error(`traces ${res.status}`);
      const data = (await res.json()) as { enabled: boolean; runs: RunSummary[] };
      setEnabled(data.enabled);
      setRuns(data.runs);
      setErr(null);
      const sel = selRef.current;
      if (sel) {
        const tr = await fetch(`/api/traces?run=${encodeURIComponent(sel)}`);
        if (tr.ok) setTrace(((await tr.json()) as { trace: RunTrace }).trace);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [auto, load]);

  const pick = useCallback(
    (run: string) => {
      setSelected(run);
      setTrace(null);
      void (async () => {
        const tr = await fetch(`/api/traces?run=${encodeURIComponent(run)}`);
        if (tr.ok) setTrace(((await tr.json()) as { trace: RunTrace }).trace);
      })();
    },
    [],
  );

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col bg-white">
        <header className="border-b border-slate-200 px-6 py-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Internal · Observability
              </p>
              <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-900">
                <Activity className="h-5 w-5 text-brand-orange" /> Run Inspector
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-600">
                Live per-run timeline of the research agent — mode routing, each
                step&apos;s latency and token cache, tool calls, the coverage gate, and
                verification + citation-faithfulness verdicts. Reads the in-memory trace
                ring; run a query in Research or the Eval harness and it appears here.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px] text-slate-600">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                  className="h-3.5 w-3.5 accent-brand-navy"
                />
                Auto-refresh
              </label>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
            </div>
          </div>
          {!enabled && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Trace capture is off in production. Set AGENT_TRACE=1 to enable.
            </div>
          )}
          {err && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {err}
            </div>
          )}
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[380px_1fr]">
          {/* Run list */}
          <div className="min-h-0 overflow-y-auto border-r border-slate-200">
            {runs.length === 0 ? (
              <p className="px-6 py-8 text-[13px] text-slate-500">
                No runs captured yet. Trigger a research query and it will show up here.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {runs.map((r) => (
                  <li key={r.run}>
                    <button
                      type="button"
                      onClick={() => pick(r.run)}
                      className={`block w-full px-4 py-3 text-left transition hover:bg-slate-50 ${
                        selected === r.run ? "bg-brand-blue-soft/40" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${statusTone(r.status)}`}
                        >
                          {r.status === "running" && <CircleDot className="h-2.5 w-2.5 animate-pulse" />}
                          {r.status}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${modeTone(r.mode)}`}
                        >
                          {r.mode ?? "?"}
                        </span>
                        <span className="ml-auto text-[11px] tabular-nums text-slate-500">
                          {ms(r.totalMs)}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-slate-800">
                        {r.query ?? r.run}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-slate-500">
                        <span>{r.steps ?? 0} steps</span>
                        <span>{r.toolCalls ?? 0} calls</span>
                        <span>{r.sources ?? 0} src</span>
                        {r.tokens && <span>{tok(r.tokens.total)} tok</span>}
                        {r.gateRequeried && <span className="text-amber-700">gate re-queried</span>}
                        {r.faith && (
                          <span className={r.faith.unsupported > 0 ? "text-amber-700" : "text-emerald-700"}>
                            faithful {r.faith.supported}/{r.faith.checked}
                          </span>
                        )}
                        {r.verify && (
                          <span>
                            facts {r.verify.verified}/{r.verify.checked}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Timeline */}
          <div className="min-h-0 overflow-y-auto bg-slate-50/40 px-6 py-5">
            {!selected ? (
              <p className="text-[13px] text-slate-500">Select a run to see its timeline.</p>
            ) : !trace ? (
              <p className="text-[13px] text-slate-500">Loading timeline…</p>
            ) : (
              <ol className="relative space-y-0 border-l border-slate-200 pl-5">
                {trace.events.map((e, i) => {
                  const d = describe(e);
                  return (
                    <li key={i} className="relative pb-4">
                      <span
                        className={`absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white ${
                          e.level === "error" ? "bg-red-500" : "bg-brand-navy/50"
                        }`}
                      />
                      <div className="flex items-baseline gap-2">
                        <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
                          {ms(e.at)}
                        </span>
                        <span className={`text-[13px] font-medium ${d.tone ?? "text-slate-900"}`}>
                          {d.title}
                        </span>
                      </div>
                      {d.detail && (
                        <p className="ml-16 mt-0.5 break-words text-[12px] leading-relaxed text-slate-600">
                          {d.detail}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
