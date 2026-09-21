import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DepositionAnalysisPane, type AnalysisTab } from "./DepositionAnalysisPane";
import { DepositionDropPanel, type DepositionDropPanelHandle } from "./DepositionDropPanel";
import { DepositionExportDialog } from "./DepositionExportDialog";
import { FileDropZone } from "./FileDropZone";
import { TranscriptPane } from "./TranscriptPane";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useMediaQuery } from "@/hooks/use-media-query";
import { takeWorkspaceHandoff } from "@/lib/kb/workspace-handoff";
import {
  DEPOSITION_TRANSCRIPT_KEY,
  readLayoutPreference,
  writeLayoutPreference,
} from "@/lib/pile/discovery-layout";
import { useDeposition, type DepSaved } from "@/lib/use-deposition";

const EASE = [0.22, 0.61, 0.36, 1] as const;

/**
 * Where this deposition set stands in the Library: saving, saved (with the
 * analysis write state), or failed with a retry. Silent while idle so a set
 * that has not finished reading shows nothing.
 */
function SavedStatus({ saved, onRetry }: { saved: DepSaved; onRetry: () => void }) {
  if (saved.status === "idle") return null;
  const base = "inline-flex items-center gap-1.5 pr-2 text-[12px]";
  if (saved.status === "saving" || saved.status === "queued" || saved.status === "embedding") {
    return (
      <span className={`${base} text-muted-foreground`} aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
        {saved.status === "saving" ? "Saving to Library…" : "Indexing…"}
        {saved.status === "queued" ? (
          <button type="button" className="font-medium underline" onClick={onRetry}>
            Check status
          </button>
        ) : null}
      </span>
    );
  }
  if (saved.status === "error") {
    return (
      <span className={`${base} text-destructive`} title={saved.message ?? undefined}>
        <AlertCircle className="h-3.5 w-3.5" />
        {saved.analysis === "saved" ? "Analysis saved · index failed" : "Save needs attention"}
        {(!saved.loaded || saved.analysis === "error") && (
          <button
            type="button"
            onClick={onRetry}
            className="font-medium underline-offset-2 hover:underline"
          >
            Retry
          </button>
        )}
      </span>
    );
  }
  const analysisNote =
    saved.analysis === "saving" || saved.analysis === "pending"
      ? "analysis saving…"
      : saved.analysis === "error"
        ? "analysis not saved"
        : saved.analysis === "saved" && saved.analysisSavedAt
          ? `analysis ${new Date(saved.analysisSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : null;
  const title = [saved.name, saved.message, saved.analysisError].filter(Boolean).join(" · ");
  return (
    <span
      className={`${base} ${saved.analysis === "error" ? "text-destructive" : "text-muted-foreground"}`}
      title={title || undefined}
    >
      {saved.analysis === "error" ? (
        <AlertCircle className="h-3.5 w-3.5" />
      ) : (
        <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
      )}
      {saved.analysis === "error" ? "Transcripts saved" : "Saved"}
      {analysisNote ? ` · ${analysisNote}` : ""}
      {saved.analysis === "error" ? (
        <button type="button" className="font-medium underline" onClick={onRetry}>
          Retry analysis save
        </button>
      ) : null}
    </span>
  );
}

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
    reloadWorkspace,
    saveWorkspace,
    deleteSaved,
  } = useDeposition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // One-click reopen: the Library "Open" hands off a saved deposition id.
  useEffect(() => {
    const id = takeWorkspaceHandoff("deposition");
    if (id) void reloadWorkspace(id);
  }, [reloadWorkspace]);
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("summary");
  // Ask scope resolves in the hook: a saved deposition set with a hybrid index
  // answers from the KB (adaptive RAG); otherwise the full-text scan runs.
  const queryOptions = { scope: "auto" as const, fileIds: undefined };
  const [mobilePane, setMobilePane] = useState<"transcript" | "analysis">("analysis");
  const [transcriptOpen, setTranscriptOpen] = useState(() =>
    readLayoutPreference(DEPOSITION_TRANSCRIPT_KEY, true),
  );
  const desktopLayout = useMediaQuery("(min-width: 1024px)");
  const askRef = useRef<HTMLInputElement>(null);
  const handleTabChange = useCallback((tab: AnalysisTab) => {
    setAnalysisTab(tab);
    setMobilePane("analysis");
    if (tab === "ask") askRef.current?.focus();
  }, []);
  const workbench = !!active;
  const ingesting = state.phase === "reading" || state.phase === "indexing";
  const analyzing = state.phase === "analyzing";
  // Whole-tab drop stages transcripts into the intake queue (same type/size
  // limits as the picker). There is no add-to-open-record path for
  // depositions, so the zone is inactive once transcripts are being read or
  // the workbench is open.
  const dropPanelRef = useRef<DepositionDropPanelHandle>(null);
  const dropEnabled = !workbench && !ingesting;
  const onTabDrop = useCallback((dropped: File[]) => {
    dropPanelRef.current?.addFiles(dropped);
  }, []);
  const running = Object.values(state.passes).filter((p) => p === "running").length;
  const fileLabel =
    state.transcripts.length > 1
      ? `${state.transcripts.length} transcripts`
      : state.witness || state.files[0]?.name || "Deposition";

  useEffect(() => {
    writeLayoutPreference(DEPOSITION_TRANSCRIPT_KEY, transcriptOpen);
  }, [transcriptOpen]);

  const handleCite = useCallback(
    (cite: string, fileName?: string) => {
      selectCite(cite, fileName);
      setTranscriptOpen(true);
      if (!desktopLayout) setMobilePane("transcript");
    },
    [desktopLayout, selectCite],
  );

  const transcriptPane = workbench ? (
    <TranscriptPane
      transcript={active!}
      files={state.transcripts.map((transcript) => ({
        fileId: transcript.fileId,
        fileName: transcript.fileName,
        witness: transcript.witness,
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
  ) : null;

  const analysisPane = workbench ? (
    <DepositionAnalysisPane
      analyzing={analyzing}
      analysis={state.analysis}
      passes={state.passes}
      role={state.role || state.analysis?.role || ""}
      answer={state.answer}
      hits={state.hits}
      asking={state.asking}
      onCite={handleCite}
      onTabChange={handleTabChange}
      transcripts={state.transcripts.map((transcript) => ({
        fileId: transcript.fileId,
        fileName: transcript.fileName,
        witness: transcript.witness,
      }))}
      onAsk={(question) => {
        setQuery(question);
        setMobilePane("analysis");
        void ask(question, queryOptions);
      }}
    />
  ) : null;

  return (
    <FileDropZone
      onFiles={onTabDrop}
      disabled={!dropEnabled}
      label="Drop transcripts to add them to the intake"
      hint="PDF, DOCX, or TXT transcripts"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {state.error && (
        <div className="mb-2 flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5">
          <AlertCircle className="mt-[1px] h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-foreground">{state.error}</p>
            <button
              type="button"
              onClick={() => void analyze()}
              disabled={analyzing || ingesting || Boolean(state.ocr) || !state.transcripts.length}
              className="mt-1 text-[11.5px] font-medium text-brand-orange hover:underline"
            >
              Retry analysis
            </button>
          </div>
        </div>
      )}

      {(state.saved.message || state.saved.analysisError) &&
      (state.saved.status === "error" ||
        state.saved.status === "ready" ||
        state.saved.analysis === "error") ? (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
        >
          <AlertCircle className="size-4 shrink-0" />
          <p className="min-w-48 flex-1">
            {[state.saved.message, state.saved.analysisError].filter(Boolean).join(" ")}
          </p>
          {(state.saved.analysis === "error" ||
            (state.saved.status === "error" && !state.saved.loaded)) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 bg-white text-xs"
              onClick={() => void saveWorkspace()}
            >
              Retry save
            </Button>
          )}
          {state.analysis ? (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={exportMemo}>
              Download analysis
            </Button>
          ) : null}
        </div>
      ) : null}

      {workbench ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-border bg-card">
          <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
            <div className="flex min-w-[14rem] flex-1 items-center gap-2">
              {desktopLayout ? (
                <button
                  type="button"
                  onClick={() => setTranscriptOpen((open) => !open)}
                  aria-expanded={transcriptOpen}
                  aria-label={transcriptOpen ? "Hide transcript" : "Show transcript"}
                  className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {transcriptOpen ? (
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  ) : (
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
              <h2 className="truncate text-[14px] font-semibold text-foreground">{fileLabel}</h2>
              <span className="border-l border-border pl-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
              <SavedStatus saved={state.saved} onRetry={() => void saveWorkspace()} />
              {analyzing || running ? (
                <span className="inline-flex items-center gap-1.5 pr-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
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
                  className="h-8 rounded-sm"
                  disabled={ingesting || Boolean(state.ocr)}
                  onClick={() => void analyze(true)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Re-run
                </Button>
              )}
              <DepositionExportDialog
                analysis={state.analysis}
                label={fileLabel}
                activeTab={analysisTab}
                complete={Object.values(state.passes).every((pass) => pass === "done")}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-sm"
                onClick={reset}
                title={
                  state.saved.itemId
                    ? "Close this set. The saved copy stays in your Library."
                    : undefined
                }
              >
                Clear
              </Button>
              {state.saved.itemId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-sm text-muted-foreground hover:text-destructive"
                  aria-label="Delete saved copy"
                  title="Delete the saved copy from your Library"
                  disabled={state.saved.status === "saving"}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </header>
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete saved deposition?</AlertDialogTitle>
                <AlertDialogDescription>
                  {state.saved.name ? `“${state.saved.name}” ` : "This set "}
                  will be removed from your Library: the transcripts, index, and verified analysis.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void deleteSaved()}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {desktopLayout && transcriptOpen ? (
            <ResizablePanelGroup
              id="deposition-workbench"
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="deposition-transcript"
                defaultSize="31%"
                minSize="280px"
                maxSize={analysisTab === "graph" ? "34%" : "54%"}
              >
                <div className="h-full min-h-0">{transcriptPane}</div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                aria-label="Resize transcript and analysis"
                className="z-20 w-1 bg-border transition-colors hover:bg-brand-navy/20 data-[resize-handle-active]:bg-brand-navy/30"
              />
              <ResizablePanel
                id="deposition-analysis"
                defaultSize="69%"
                minSize={analysisTab === "graph" ? "520px" : "440px"}
              >
                <div className="h-full min-h-0">{analysisPane}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : desktopLayout ? (
            <div className="min-h-0 flex-1">{analysisPane}</div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div
                className="grid h-11 shrink-0 grid-cols-2 border-b border-border bg-surface p-1"
                role="tablist"
                aria-label="Deposition workspace panes"
              >
                {(["transcript", "analysis"] as const).map((pane) => (
                  <button
                    key={pane}
                    id={`deposition-${pane}-tab`}
                    type="button"
                    role="tab"
                    aria-selected={mobilePane === pane}
                    aria-controls={`deposition-${pane}-panel`}
                    onClick={() => setMobilePane(pane)}
                    className={`border-b-2 text-[12px] font-medium capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      mobilePane === pane
                        ? "border-brand-navy bg-slate-50 text-brand-navy"
                        : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    {pane}
                  </button>
                ))}
              </div>
              <div
                id="deposition-transcript-panel"
                role="tabpanel"
                aria-labelledby="deposition-transcript-tab"
                hidden={mobilePane !== "transcript"}
                className="min-h-0 flex-1"
              >
                {transcriptPane}
              </div>
              <div
                id="deposition-analysis-panel"
                role="tabpanel"
                aria-labelledby="deposition-analysis-tab"
                hidden={mobilePane !== "analysis"}
                className="min-h-0 flex-1"
              >
                {analysisPane}
              </div>
            </div>
          )}

          <form
            className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-1.5 sm:flex-nowrap sm:gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setMobilePane("analysis");
              void ask(state.query, queryOptions);
            }}
          >
            <label
              htmlFor="dep-ask"
              className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-400"
            >
              Ask
            </label>
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                id="dep-ask"
                ref={askRef}
                value={state.query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask across testimony, issues, conflicts, or exhibits"
                className="h-8 w-full rounded-sm border border-border bg-card pl-8 pr-3 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-brand-navy/35 focus:ring-1 focus:ring-brand-navy/10"
              />
            </div>
            <Button
              type="submit"
              className="h-8 rounded-sm px-3"
              disabled={
                !state.query.trim() || state.asking || analyzing || ingesting || Boolean(state.ocr)
              }
            >
              {state.asking ? "Asking…" : "Ask"}
            </Button>
          </form>
        </div>
      ) : ingesting ? (
        <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto py-1 sm:py-4">
          <div className="mx-auto w-full max-w-[820px] rounded-sm border border-border bg-card p-4 sm:p-5">
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
                      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy motion-safe:animate-spin" />
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
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto py-1 lg:items-center lg:py-6">
          <AnimatePresence initial={false}>
            <motion.div
              key="dep-drop"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: EASE }}
              className="w-full max-w-[820px] pb-6"
            >
              <DepositionDropPanel
                ref={dropPanelRef}
                onStart={(f, i) =>
                  void (async () => {
                    // Auto-save + index transcripts on upload so Ask is RAG-ready
                    // immediately, with no full-text scan fallback.
                    await start(f, i);
                    await saveWorkspace();
                  })()
                }
                busy={false}
                files={[]}
              />
              <p className="mx-auto mt-3 max-w-2xl text-center text-[12px] leading-relaxed text-muted-foreground">
                Build a cite-addressable transcript record, then review admissions, conflicts,
                chronology, exhibits, and connections.
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </FileDropZone>
  );
}
