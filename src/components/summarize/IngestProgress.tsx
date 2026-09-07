import { useState } from "react";
import { AlertCircle, Check, FileText, Loader2 } from "lucide-react";

import type { PileFileState } from "@/lib/use-pile";

export function IngestProgress({ files, indexing }: { files: PileFileState[]; indexing: boolean }) {
  const [showErrors, setShowErrors] = useState(false);
  const ok = files.filter((f) => f.status !== "error");
  const failed = files.filter((f) => f.status === "error");
  const done = ok.reduce((n, f) => n + f.done, 0);
  const total = ok.reduce((n, f) => n + Math.max(f.pages, f.done), 0);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 6;
  const collapse = failed.length > 3 && !showErrors;

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px] font-semibold text-foreground">
            {indexing ? "Indexing the working set" : "Reading documents"}
          </p>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {total ? `${done.toLocaleString()} / ${total.toLocaleString()} pages` : "starting…"}
          </span>
        </div>
        <div className="mt-2.5 h-1 w-full overflow-hidden bg-muted">
          <div
            className="h-full bg-brand-orange transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Everything stays in this tab — pages are never uploaded or saved.
        </p>
      </div>

      <ul className="divide-y divide-border/60">
        {ok.map((f) => {
          const filePct = f.pages ? Math.min(100, Math.round((f.done / f.pages) * 100)) : 8;
          return (
            <li key={f.name} className="flex items-center gap-3 px-5 py-2.5">
              {f.status === "ready" ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2.5} />
              ) : (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-orange" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-foreground">{f.name}</p>
                {f.status === "ready" ? null : (
                  <div className="mt-1.5 h-1 w-full overflow-hidden bg-muted">
                    <div
                      className="h-full bg-brand-navy/40 transition-all duration-300"
                      style={{ width: `${filePct}%` }}
                    />
                  </div>
                )}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {f.status === "ready"
                  ? `${f.pages.toLocaleString()} pp`
                  : f.pages
                    ? `${f.done}/${f.pages}`
                    : "…"}
              </span>
            </li>
          );
        })}

        {failed.length > 0 && collapse ? (
          <li className="px-5 py-2.5">
            <button
              type="button"
              onClick={() => setShowErrors(true)}
              className="text-[12px] font-medium text-destructive hover:underline"
            >
              {failed.length} files skipped — show
            </button>
          </li>
        ) : (
          failed.map((f) => (
            <li key={f.name} className="flex items-start gap-3 bg-destructive/5 px-5 py-2.5">
              <AlertCircle className="mt-[2px] h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-foreground">{f.name}</p>
                <p className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
                  {f.error ?? "Could not be read"} — the rest of the pile continues.
                </p>
              </div>
            </li>
          ))
        )}

        {!files.length && (
          <li className="flex items-center gap-3 px-5 py-3 text-[12.5px] text-muted-foreground">
            <FileText className="h-4 w-4" /> Preparing files…
          </li>
        )}
      </ul>
    </div>
  );
}
