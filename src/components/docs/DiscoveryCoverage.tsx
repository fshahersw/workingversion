import { FileSearch, RotateCcw, Square } from "lucide-react";
import type { DiscoveryScope, ScanCoverage } from "@/lib/pile/discovery-scan";

export function DiscoveryScopeControl({
  scope,
  onChange,
  disabled,
  count,
}: {
  scope: DiscoveryScope;
  onChange: (scope: DiscoveryScope) => void;
  disabled?: boolean;
  count: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <FileSearch className="h-3.5 w-3.5 text-slate-500" />
      <select
        aria-label="Query coverage"
        value={scope}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as DiscoveryScope)}
        className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-navy"
      >
        <option value="full">Full text scan</option>
        <option value="relevant">Relevant passages · faster</option>
      </select>
      <span>
        {count} document{count === 1 ? "" : "s"} in scope
      </span>
      <span className="text-slate-500">
        {scope === "full"
          ? "Every available text page · takes longer"
          : "Selected passages · not exhaustive"}
      </span>
    </div>
  );
}

export function DiscoveryCoverage({
  coverage,
  onRetry,
  onCancel,
}: {
  coverage?: ScanCoverage | null;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  if (!coverage) return null;
  const read = coverage.files.reduce((n, f) => n + f.readPages, 0);
  const total = coverage.files.reduce((n, f) => n + f.totalPages, 0);
  const partial = read < total || coverage.failedWindows > 0;
  return (
    <details className="group mx-3 my-2 shrink-0 rounded-lg border border-slate-200 bg-white text-xs shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-slate-700">
        <span
          className={`h-2 w-2 rounded-full ${coverage.running ? "animate-pulse bg-blue-600" : partial ? "bg-amber-500" : "bg-emerald-600"}`}
        />
        <span className="font-semibold">
          {coverage.running
            ? "Scanning documents"
            : partial
              ? "Coverage needs attention"
              : "Text scan complete"}
        </span>
        <span aria-live="polite">
          {read.toLocaleString()} / {total.toLocaleString()} pages · {coverage.completedWindows}/
          {coverage.totalWindows} sections
        </span>
        {coverage.reusedWindows > 0 && <span>{coverage.reusedWindows} reused</span>}
        {coverage.retrying > 0 && <span>{coverage.retrying} retries</span>}
        <span className="ml-auto text-slate-500">
          Details <span className="inline-block transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="border-t border-slate-100 px-3 py-2">
        <p className="mb-2 text-slate-600">
          Coverage measures text processed, not guaranteed recall or legal accuracy. Empty or
          unavailable pages require source review.
        </p>
        <div className="max-h-40 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 font-medium">Document</th>
                <th className="text-right font-medium">Pages scanned</th>
                <th className="pl-3 font-medium">Gaps</th>
              </tr>
            </thead>
            <tbody>
              {coverage.files.map((f) => (
                <tr key={f.id} className="border-t border-slate-100">
                  <td className="max-w-64 truncate py-1.5 pr-3" title={f.name}>
                    {f.name}
                  </td>
                  <td className="text-right tabular-nums">
                    {f.readPages}/{f.totalPages}
                  </td>
                  <td className="pl-3 text-amber-800">
                    {[
                      f.missingPages ? `${f.missingPages} without text` : "",
                      f.failedWindows ? `${f.failedWindows} sections need retry` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex gap-3">
          {coverage.running && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 font-medium text-slate-800"
            >
              <Square className="h-3 w-3" />
              Stop scan
            </button>
          )}
          {!coverage.running && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 font-medium text-brand-navy"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry using completed sections
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
