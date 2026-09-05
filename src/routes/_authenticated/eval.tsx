import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Play, Square, Download } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EVAL_SET } from "@/lib/eval-set";
import {
  emptyResult,
  runEvalCase,
  summarize,
  toCSV,
  type EvalResult,
} from "@/lib/eval-runner";

export const Route = createFileRoute("/_authenticated/eval")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Research Eval Harness — Seeger Weiss Platform" },
      {
        name: "description",
        content:
          "Internal evaluation harness scoring the litigation research agent on citation precision, source tiering, and latency.",
      },
      {
        property: "og:title",
        content: "Research Eval Harness — Seeger Weiss Platform",
      },
      {
        property: "og:description",
        content:
          "Internal evaluation harness scoring the litigation research agent on citation precision, source tiering, and latency.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EvalPage,
});

function pct(n: number) {
  return `${n}%`;
}

function scoreTone(s: number) {
  if (s >= 80) return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (s >= 60) return "text-amber-700 bg-amber-50 border-amber-200";
  return "text-red-700 bg-red-50 border-red-200";
}

function EvalPage() {
  const [results, setResults] = useState<EvalResult[]>(() =>
    EVAL_SET.map(emptyResult),
  );
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const summary = useMemo(() => summarize(results), [results]);

  const update = useCallback((r: EvalResult) => {
    setResults((prev) => prev.map((x) => (x.id === r.id ? r : x)));
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setResults(EVAL_SET.map(emptyResult));
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for (const c of EVAL_SET) {
        if (ac.signal.aborted) break;
        await runEvalCase(c, update, ac.signal);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, update]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const download = useCallback(() => {
    const blob = new Blob([toCSV(results)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research-eval-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <header className="border-b border-slate-200 px-6 py-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Internal
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
                Research Evaluation Harness
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-600">
                Replays {EVAL_SET.length} gold-standard litigation questions
                through the live research agent and scores term coverage,
                authority coverage, source tiering, fact-check verification, and
                latency.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={running ? stop : run}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-brand-navy px-3.5 text-[13px] font-medium text-white transition hover:opacity-90"
              >
                {running ? (
                  <>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" /> Run suite
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Scored", `${summary.cases}/${EVAL_SET.length}`],
              ["Avg score", `${summary.avgScore}`],
              ["Term recall", pct(summary.termRecall)],
              ["Verified claims", pct(summary.verificationRate)],
              ["Tier pass", pct(summary.tierPassRate)],
              ["Avg latency", `${(summary.avgLatencyMs / 1000).toFixed(1)}s`],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {label}
                </div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </header>

        <div className="px-6 py-5">
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                  <th className="px-3 py-2 font-semibold">Case</th>
                  <th className="px-3 py-2 font-semibold">Category</th>
                  <th className="px-3 py-2 text-right font-semibold">Score</th>
                  <th className="px-3 py-2 text-right font-semibold">Terms</th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Authorities
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    T1/T2/T3
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Verified
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    First token
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const c = EVAL_SET[i];
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-slate-200 align-top ${
                        i % 2 ? "bg-slate-50/40" : "bg-white"
                      }`}
                    >
                      <td className="max-w-[420px] px-3 py-2">
                        <div className="font-medium text-slate-900">{r.id}</div>
                        <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-600">
                          {r.question}
                        </div>
                        {r.status === "running" && (
                          <div className="mt-1 text-[11px] font-medium text-brand-orange">
                            Running…
                          </div>
                        )}
                        {r.error && (
                          <div className="mt-1 text-[11px] text-red-600">
                            {r.error}
                          </div>
                        )}
                        {r.status === "done" && r.termMisses.length > 0 && (
                          <div className="mt-1 text-[11px] text-slate-500">
                            Missing: {r.termMisses.join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.category}</td>
                      <td className="px-3 py-2 text-right">
                        {r.status === "done" ? (
                          <span
                            className={`inline-block rounded border px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${scoreTone(r.score)}`}
                          >
                            {r.score}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.termHits.length}/{c.expectTerms.length}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.authorityHits.length}/{c.expectAuthorities.length}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.tier1}/{r.tier2}/{r.tier3}
                        {r.staleSources > 0 && (
                          <span className="ml-1 text-[11px] text-amber-700">
                            ({r.staleSources} stale)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.claimsChecked
                          ? `${r.claimsVerified}/${r.claimsChecked}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.firstTokenMs
                          ? `${(r.firstTokenMs / 1000).toFixed(1)}s`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.latencyMs
                          ? `${(r.latencyMs / 1000).toFixed(1)}s`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
            Scoring: term coverage 30%, authority coverage 20%, fact-check
            verification 25%, required source tier 15%, grounding depth 10%.
            Cases run sequentially to stay inside gateway rate limits.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
