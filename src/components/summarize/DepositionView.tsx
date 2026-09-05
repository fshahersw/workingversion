import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Download, Loader2, RotateCcw, Search } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { DepositionAnalysisPane, type AnalysisTab } from "./DepositionAnalysisPane";
import { DepositionDropPanel } from "./DepositionDropPanel";
import { TranscriptPane } from "./TranscriptPane";
import { Button } from "@/components/ui/button";
import { useDeposition } from "@/lib/use-deposition";

const EASE = [0.22, 0.61, 0.36, 1] as const;

export function DepositionView() {
  const {
    state,
    active,
    start,
    analyze,
    ask,
    reset,
    exportMemo,
    setSearch,
    setRegex,
    setSpeaker,
    setQuery,
    setActiveFile,
    selectCite,
  } = useDeposition();
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("summary");
  const askRef = useRef<HTMLInputElement>(null);
  const handleTabChange = useCallback((tab: AnalysisTab) => {
    setAnalysisTab(tab);
    if (tab === "ask") askRef.current?.focus();
  }, []);
  const workbench = !!active;
  const ingesting = state.phase === "reading" || state.phase === "indexing";
  const analyzing = state.phase === "analyzing";
  const running = Object.values(state.passes).filter((p) => p === "running").length;
  const fileLabel =
    state.transcripts.length > 1
      ? `${state.transcripts.length} transcripts`
      : state.witness || state.files[0]?.name || "Deposition";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {state.error && (
        <div className="mb-2 flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5">
          <AlertCircle className="mt-[1px] h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-foreground">{state.error}</p>
            <button
              type="button"
              onClick={reset}
              className="mt-1 text-[11.5px] font-medium text-brand-orange hover:underline"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {workbench ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border/80 bg-white">
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border/80 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[14px] font-semibold text-foreground">{fileLabel}</h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                {state.transcripts.length > 1 ? "Set" : "Witness"}
              </span>
              <p className="hidden truncate text-[12px] text-muted-foreground sm:block">
                {[
                  state.mdl,
                  state.taken ? `Deposed ${state.taken}` : null,
                  state.pageCount ? `${state.pageCount.toLocaleString()} pp` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {state.ocr ? (
                <span className="hidden pr-2 text-[12px] tabular-nums text-muted-foreground sm:inline">
                  OCR {state.ocr.done}/{state.ocr.total}
                </span>
              ) : null}
              {analyzing || running ? (
                <span className="inline-flex items-center gap-1.5 pr-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {state.passes.cross === "running"
                    ? "Cross-checking transcripts…"
                    : state.analyzeProgress
                      ? `Covering ${state.analyzeProgress.done}/${state.analyzeProgress.total} windows…`
                      : `Analyzing${state.transcripts.length > 1 ? ` ${state.transcripts.length} files` : ""}…`}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md"
                  onClick={() => void analyze()}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Re-run
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-md"
                disabled={!state.analysis?.summary && !state.analysis?.admissions.length}
                onClick={exportMemo}
              >
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-md"
                onClick={reset}
              >
                Clear
              </Button>
            </div>
          </header>

          <form
            className="flex h-12 shrink-0 items-center gap-3 border-b border-border/80 bg-white px-4"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(state.query);
            }}
          >
            <label
              htmlFor="dep-ask"
              className="w-[7.25rem] shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400"
            >
              Ask the set
            </label>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="dep-ask"
                ref={askRef}
                value={state.query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Notice, product ID, conflicts across witnesses…"
                className="h-9 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
              />
            </div>
            <Button
              type="submit"
              className="h-9 rounded-md px-3.5"
              disabled={!state.query.trim() || state.asking}
            >
              {state.asking ? "Asking…" : "Ask"}
            </Button>
          </form>

          <div
            className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden ${
              analysisTab === "graph"
                ? "grid-cols-[minmax(240px,28%)_minmax(0,1fr)]"
                : "grid-cols-[minmax(300px,38%)_minmax(0,1fr)]"
            }`}
          >
            <TranscriptPane
              transcript={active!}
              files={state.transcripts.map((t) => ({
                fileId: t.fileId,
                fileName: t.fileName,
                witness: t.witness,
              }))}
              activeFileId={state.activeFileId}
              search={state.search}
              regex={state.regex}
              speaker={state.speaker}
              selectedCite={state.selectedCite}
              onSearch={setSearch}
              onRegex={setRegex}
              onSpeaker={setSpeaker}
              onSelectFile={setActiveFile}
            />
            <DepositionAnalysisPane
              analyzing={analyzing}
              analysis={state.analysis}
              passes={state.passes}
              role={state.role || state.analysis?.role || ""}
              answer={state.answer}
              hits={state.hits}
              asking={state.asking}
              onCite={selectCite}
              onTabChange={handleTabChange}
            />
          </div>
        </div>
      ) : ingesting ? (
        <div className="mx-auto w-full max-w-[720px] rounded-2xl border border-border bg-card p-5">
          <p className="mb-2 text-[13px] font-semibold text-foreground">Reading transcripts</p>
          <DepositionDropPanel
            onStart={() => {}}
            busy
            files={state.files.map((f) => ({
              name: f.name,
              pages: f.pages,
              done: f.done,
              status: f.status,
            }))}
          />
          {state.steps.length ? (
            <ul className="mt-4 space-y-1.5 border-t border-border/70 pt-3">
              {state.steps.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-[12.5px]">
                  {s.status === "running" ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-brand-navy" />
                  ) : s.status === "error" ? (
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  )}
                  <span>
                    <span className="text-foreground">{s.label}</span>
                    {s.detail ? (
                      <span className="ml-1.5 text-muted-foreground">{s.detail}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
          <AnimatePresence initial={false}>
            <motion.div
              key="dep-drop"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: EASE }}
              className="w-full max-w-[720px] pb-6"
            >
              <DepositionDropPanel onStart={(f, i) => void start(f, i)} busy={false} files={[]} />
              <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                Upload deposition transcripts. The AI extracts witness details, page:line citations,
                and cross-transcript patterns.
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
