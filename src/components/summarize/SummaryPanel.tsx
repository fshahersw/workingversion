import { AlertTriangle, Check, Copy, Download, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import { Button } from "@/components/ui/button";
import type { SummarizerState } from "@/lib/use-summarizer";

export function SummaryPanel({
  state,
  onReset,
  onCancel,
}: {
  state: SummarizerState;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [factFilter, setFactFilter] = useState<string>("all");
  const kinds = useMemo(() => [...new Set(state.facts.map((f) => f.kind))].sort(), [state.facts]);
  const shownFacts = useMemo(
    () => (factFilter === "all" ? state.facts : state.facts.filter((f) => f.kind === factFilter)),
    [state.facts, factFilter],
  );
  const streaming = state.phase === "writing";

  const copy = async () => {
    await navigator.clipboard.writeText(state.summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const download = () => {
    const blob = new Blob([state.summary], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.title || "summary"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-foreground">{state.title}</h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {state.pageCount} page{state.pageCount === 1 ? "" : "s"}
            {state.durationMs ? ` · ${Math.round(state.durationMs / 1000)}s` : ""}
            {state.savedId ? " · saved" : ""}
          </p>
        </div>
        {streaming || state.phase === "thinking" ? (
          <Button variant="outline" size="sm" className="rounded-lg" onClick={onCancel}>
            Stop
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              title="Copy markdown"
              onClick={copy}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              title="Download markdown"
              onClick={download}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              title="New summary"
              onClick={onReset}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-card px-6 py-6">
        {state.summary ? (
          <AnswerMarkdown text={state.summary} onCite={() => {}} streaming={streaming} />
        ) : (
          <div className="space-y-2.5 py-2">
            {[92, 78, 85, 60].map((w, i) => (
              <div
                key={i}
                className="h-3 animate-pulse rounded bg-muted"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        )}
        {streaming && (
          <span className="ml-[2px] inline-block h-[1em] w-[2px] translate-y-[3px] animate-pulse rounded-sm bg-brand-orange/80" />
        )}

        {state.conflicts.length > 0 && (
          <div className="mt-6 rounded-lg border-l-2 border-amber-400/70 bg-amber-50/40 px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              Conflicts &amp; ambiguities
            </div>
            <ul className="space-y-1.5">
              {state.conflicts.map((c, i) => (
                <li key={i} className="text-[12.5px] leading-relaxed text-foreground">
                  <span className="font-medium">{c.issue}</span>
                  {c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}
                  {c.pages.length ? (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      [pp. {c.pages.join(", ")}]
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.facts.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-navy/60">
                Key facts
              </span>
              {["all", ...kinds].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFactFilter(k)}
                  className={`rounded-full border px-2 py-0.5 text-[10.5px] capitalize transition-colors ${
                    factFilter === k
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {k}
                  {k === "all" ? ` ${state.facts.length}` : ""}
                </button>
              ))}
              {state.coverage ? (
                <span className="ml-auto text-[10.5px] text-muted-foreground">
                  {state.coverage.covered}/{state.coverage.critical} critical facts in memo
                </span>
              ) : null}
            </div>
            <div className="max-h-[320px] overflow-y-auto">
              <table className="w-full border-collapse text-left">
                <tbody>
                  {shownFacts.map((f, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0 align-top">
                      <td className="w-[88px] px-1 py-2">
                        <span className="inline-flex items-center gap-1.5 text-[10.5px] capitalize text-muted-foreground">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-navy/50" />
                          {f.kind}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-[12.5px] leading-relaxed text-foreground">
                        {f.claim}
                        {f.quote ? (
                          <span className="mt-0.5 block text-[11.5px] italic text-muted-foreground">
                            &ldquo;{f.quote}&rdquo;
                          </span>
                        ) : null}
                      </td>
                      <td className="w-[52px] py-2 pr-1 text-right text-[11px] tabular-nums text-muted-foreground">
                        p. {f.page}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
