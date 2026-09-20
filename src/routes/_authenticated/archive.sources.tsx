import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { getArchiveCoverage, getArchiveHealth, type CoverageSnapshot } from "@/lib/archive/archive.functions";
import type { ArchiveHealth } from "@/lib/archive/client.server";
import { ARCHIVE_CAVEATS } from "@/lib/archive/policy";

// Sources & Coverage: the first Legal Archive page. It proves the pipe
// (auth -> app -> distribution -> ALB -> gateway -> archive) and shows what the
// archive itself reports: layer readiness with hash verification, the summary
// counts, the coverage matrix and the known gaps. Nothing here is computed
// by the platform; every number is the archive's own, labelled as such.

export const Route = createFileRoute("/_authenticated/archive/sources")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sources & Coverage — Seeger Weiss Platform" },
      { name: "description", content: "Legal Archive layer readiness, coverage and known gaps." },
    ],
  }),
  component: SourcesPage,
});

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** Arrays of flat objects render as tables, objects as key/value lists, anything else as JSON. Shapes are the archive's; nothing is reinterpreted. */
function Structured({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  if (isScalar(value)) return <span className="tabular-nums">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">none</span>;
    if (value.every((row) => row && typeof row === "object" && !Array.isArray(row) && Object.values(row as object).every(isScalar))) {
      const columns = [...new Set(value.flatMap((row) => Object.keys(row as object)))].slice(0, 12);
      return (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="min-w-full text-[12.5px]">
            <thead className="bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              <tr>{columns.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {value.slice(0, 200).map((row, i) => (
                <tr key={i} className="odd:bg-white even:bg-slate-50/40">
                  {columns.map((c) => <td key={c} className="px-3 py-1.5 align-top text-slate-700">{isScalar((row as Record<string, unknown>)[c]) ? String((row as Record<string, unknown>)[c] ?? "") : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {value.length > 200 && <p className="px-3 py-2 text-[11px] text-slate-500">{value.length - 200} more rows not shown</p>}
        </div>
      );
    }
    if (value.every(isScalar)) return <span className="text-slate-700">{value.map(String).join(", ")}</span>;
    return <pre className="max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-[11.5px] text-slate-700">{JSON.stringify(value, null, 1).slice(0, 8000)}</pre>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth > 1) return <pre className="max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-[11.5px] text-slate-700">{JSON.stringify(value, null, 1).slice(0, 8000)}</pre>;
    return (
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">{k}</dt>
            <dd className="mt-0.5 text-[13px] text-slate-800"><Structured value={v} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function Badge({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const tone = ok === null ? "border-slate-200 bg-slate-50 text-slate-600" : ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>;
}

function SourcesPage() {
  const [health, setHealth] = useState<ArchiveHealth | null>(null);
  const [coverage, setCoverage] = useState<CoverageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const h = await getArchiveHealth();
      setHealth(h);
      if (h.reachable) setCoverage(await getArchiveCoverage());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = health?.supplements.filter((s) => s.ready).length ?? 0;
  const total = health?.supplements.length ?? 0;

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white">
        <header className="border-b border-slate-200 px-6 py-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Corpus</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Sources &amp; Coverage</h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-600">
                What the Legal Archive reports about itself: which data layers are ready and hash-verified, the saved-record counts, the coverage matrix and the gaps it declares. Counts are counts of saved records, never completeness.
              </p>
            </div>
            <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-5">
            {[
              ["Configured", health ? (health.configured ? "yes" : "no") : "…"],
              ["Reachable", health ? (health.reachable ? "yes" : "no") : "…"],
              ["Layers ready", health ? `${ready}/${total}` : "…"],
              ["Workbench", health ? (health.workbench.reachable ? "up" : "down") : "…"],
              ["Checked", health ? new Date(health.checkedAt).toLocaleTimeString() : "…"],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900">{value}</div>
              </div>
            ))}
          </div>
        </header>

        <div className="flex-1 space-y-8 px-6 py-6">
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}

          {health && !health.configured && (
            <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
              The Legal Archive is not configured for this environment (LEGAL_ARCHIVE_URL and ARCHIVE_APP_KEY). Deploy the legal-archive stacks, then redeploy the platform with <code className="rounded bg-white/70 px-1">bun run deploy:testing --refresh-env</code>.
            </section>
          )}

          {health?.configured && !health.reachable && (
            <section className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              Configured but unreachable: {health.error ?? "no response"}. The service task may still be waiting for the first release pull; see the legal-archive runbook.
            </section>
          )}

          {health?.reachable && (
            <>
              <section>
                <h2 className="text-[13px] font-semibold text-slate-900">Data layers</h2>
                <p className="mt-0.5 text-[12px] text-slate-500">From the archive's /api/supplements. A layer that failed its hash or validation check answers available:false everywhere and is shown closed here rather than worked around.</p>
                {health.supplements.length === 0 ? (
                  <p className="mt-3 text-[13px] text-slate-500">The archive reported no supplement layers.</p>
                ) : (
                  <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
                    <table className="min-w-full text-[12.5px]">
                      <thead className="bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                        <tr><th className="px-3 py-2">Layer</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Detail</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {health.supplements.map((s) => (
                          <tr key={s.id}>
                            <td className="px-3 py-1.5 font-medium text-slate-800">{s.label ?? s.id}{s.label && <span className="ml-2 text-[11px] text-slate-400">{s.id}</span>}</td>
                            <td className="px-3 py-1.5"><Badge ok={s.ready}>{s.ready ? "ready" : "closed"}</Badge></td>
                            <td className="px-3 py-1.5 text-slate-600">{s.detail ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {health.summary !== null && (
                <section>
                  <h2 className="text-[13px] font-semibold text-slate-900">Summary</h2>
                  <p className="mt-0.5 text-[12px] text-slate-500">The archive's /api/summary, verbatim. {ARCHIVE_CAVEATS.counts}</p>
                  <div className="mt-3 rounded-md border border-slate-200 p-4"><Structured value={health.summary} /></div>
                </section>
              )}

              <section>
                <h2 className="text-[13px] font-semibold text-slate-900">Coverage</h2>
                <p className="mt-0.5 text-[12px] text-slate-500">The archive's coverage labels and matrix (/api/coverage/*). {ARCHIVE_CAVEATS.incomplete}</p>
                {coverage?.error && <p className="mt-2 text-[12px] text-red-700">{coverage.error}</p>}
                {coverage?.labels !== null && coverage?.labels !== undefined && <div className="mt-3 rounded-md border border-slate-200 p-4"><Structured value={coverage.labels} /></div>}
                {coverage?.matrix !== null && coverage?.matrix !== undefined && <div className="mt-3 rounded-md border border-slate-200 p-4"><Structured value={coverage.matrix} /></div>}
              </section>

              {health.workbench.health !== null && (
                <section>
                  <h2 className="text-[13px] font-semibold text-slate-900">Corpus Workbench</h2>
                  <p className="mt-0.5 text-[12px] text-slate-500">Import completeness per collection from the workbench's /api/health. A bounded import is a sample of the archive; partial collections are labelled partial.</p>
                  <div className="mt-3 rounded-md border border-slate-200 p-4"><Structured value={health.workbench.health} /></div>
                </section>
              )}
            </>
          )}

          <section>
            <h2 className="text-[13px] font-semibold text-slate-900">Ground rules carried into every answer</h2>
            <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-slate-600">
              {Object.values(ARCHIVE_CAVEATS).map((c) => <li key={c} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400" />{c}</li>)}
            </ul>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
