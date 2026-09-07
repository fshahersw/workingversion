import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ChevronDown,
  FileStack,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DocumentReader } from "./DocumentReader";
import { DropPanel } from "./DropPanel";
import { IngestProgress } from "./IngestProgress";
import { ReasoningRail } from "./ReasoningRail";
import { docTypeOf, fileFormat, RefineRail } from "./RefineRail";
import { ResultsPane } from "./ResultsPane";
import { StructureRail } from "./StructureRail";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  readLayoutPreference,
  WORKING_SET_FILES_KEY,
  writeLayoutPreference,
} from "@/lib/pile/discovery-layout";
import { suggestQuestions } from "@/lib/pile/suggest-questions";
import { pileJob, type PileJobId } from "@/lib/pile/jobs";
import type { PileFile, PileFileHits } from "@/lib/pile/types";
import { useSharedPile } from "@/lib/pile-context";
import type { Step } from "@/lib/use-summarizer";

const EASE = [0.22, 0.61, 0.36, 1] as const;

type Mode = "search" | "ask";

function fileAsGroup(file: PileFile, hits: PileFileHits["hits"]): PileFileHits {
  const own = hits.filter((h) => h.fileId === file.id);
  return {
    fileId: file.id,
    fileName: file.name,
    pageCount: file.pageCount,
    matched: own.length > 0,
    topScore: own[0]?.score ?? 0,
    hits: own,
  };
}

export function SummarizeView() {
  const {
    state,
    start,
    addFiles,
    search,
    ask,
    reset,
    loadPage,
    saveWorkspace,
    reloadWorkspace,
    setQuery,
    selectHit,
  } = useSharedPile();
  const [saveOpen, setSaveOpen] = useState(false);
  const [wsName, setWsName] = useState("");
  const [wsFolder, setWsFolder] = useState("");

  // One-click reload: the Library "Open" hands off a workspace id via sessionStorage.
  useEffect(() => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem("kb:reloadWorkspace");
      if (id) sessionStorage.removeItem("kb:reloadWorkspace");
    } catch {
      /* sessionStorage unavailable */
    }
    if (id) void reloadWorkspace(id);
  }, [reloadWorkspace]);
  const [mode, setMode] = useState<Mode>("ask");
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [formats, setFormats] = useState<Set<string>>(new Set());
  const [restrictIds, setRestrictIds] = useState<Set<string>>(new Set());
  const [followUp, setFollowUp] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(() =>
    readLayoutPreference(WORKING_SET_FILES_KEY, false),
  );
  const desktopLayout = useMediaQuery("(min-width: 1024px)");
  const wideLayout = useMediaQuery("(min-width: 1280px)");

  const started = state.phase !== "idle";
  const ingesting = state.phase === "reading" || state.phase === "indexing";
  const busy = ingesting || state.phase === "asking" || state.adding;
  const files = state.session?.files ?? [];

  useEffect(() => {
    writeLayoutPreference(WORKING_SET_FILES_KEY, filesOpen);
  }, [filesOpen]);

  useEffect(() => {
    if (state.phase !== "reading" && state.phase !== "indexing" && !state.adding) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.phase, state.adding]);

  const railSteps: Step[] = state.steps.map((s) => ({
    id: s.id,
    label: s.label,
    detail: s.detail,
    status: s.status,
  }));

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const visibleGroups = useMemo(
    () =>
      state.groups.filter((g) => {
        if (types.size && !types.has(docTypeOf(g.fileName, state.structure))) return false;
        if (formats.size && !formats.has(fileFormat(g.fileName))) return false;
        return true;
      }),
    [state.groups, state.structure, types, formats],
  );

  const suggestions = useMemo(
    () => suggestQuestions(state.structure, state.session?.instructions),
    [state.structure, state.session?.instructions],
  );

  const selectedIdx = state.citePages.findIndex((p) => `${p.fileId}:${p.page}` === state.selected);
  const selectedRef = selectedIdx >= 0 ? state.citePages[selectedIdx]!.ref : null;

  const fileIds = restrictIds.size ? [...restrictIds] : undefined;

  const [readerFile, readerPageRaw] = (state.selected ?? "").split(":");
  const selectedFile = files.find((f) => f.id === readerFile);
  const dockFile = selectedFile ?? files[0];
  const readerPage = selectedFile ? Number(readerPageRaw) || 1 : 1;
  const readerGroup = dockFile ? fileAsGroup(dockFile, state.hits) : undefined;
  const overlayOpen = !!selectedFile && readerOpen && !wideLayout;
  const dockFileId = dockFile?.id;

  useEffect(() => {
    if (!overlayOpen && !refineOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (overlayOpen) {
        selectHit(null);
        setReaderOpen(false);
      } else {
        setRefineOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [overlayOpen, refineOpen, selectHit]);

  useEffect(() => {
    if (!dockFileId) return;
    void loadPage(dockFileId, readerPage);
  }, [dockFileId, readerPage, loadPage]);

  const openPage = (fileId: string, page: number) => {
    setReaderOpen(true);
    selectHit(`${fileId}:${page}`);
    void loadPage(fileId, page);
  };

  const submit = () => {
    const q = state.query.trim();
    if (!q || busy) return;
    if (mode === "ask") void ask(q, { followUp, fileIds });
    else void search(q, { fileIds });
  };

  const runSuggestion = (question: string) => {
    setMode("ask");
    setQuery(question);
    void ask(question, { followUp, fileIds });
  };

  const runJob = (id: PileJobId) => {
    const job = pileJob(id);
    if (!job || busy) return;
    setMode("ask");
    setQuery(job.query);
    void ask(job.query, { job: id, followUp: false, fileIds });
  };

  const clearSession = () => {
    if (
      !window.confirm(
        "Clear this working set? Indexed pages are kept on this device until you clear them.",
      )
    ) {
      return;
    }
    reset();
    setRestrictIds(new Set());
    setFollowUp(false);
    setReaderOpen(false);
  };

  const refine = (
    <RefineRail
      files={files}
      structure={state.structure}
      selectedTypes={types}
      selectedFormats={formats}
      selectedFileId={dockFile?.id ?? null}
      restrictFileIds={restrictIds}
      adding={state.adding}
      onToggleType={(k) => setTypes((s) => toggle(s, k))}
      onToggleFormat={(k) => setFormats((s) => toggle(s, k))}
      onToggleRestrict={(id) =>
        setRestrictIds((s) => {
          const next = new Set(s);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onClear={() => {
        setTypes(new Set());
        setFormats(new Set());
        setRestrictIds(new Set());
      }}
      onOpen={openPage}
      onAddFiles={(incoming) => void addFiles(incoming)}
      onClose={() => {
        if (desktopLayout) setFilesOpen(false);
        else setRefineOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setDetailOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-2"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          How this was built
        </span>
        <span className="h-px flex-1 bg-border" />
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${detailOpen ? "rotate-180" : ""}`}
        />
      </button>
      {detailOpen ? (
        <>
          {state.structure && <StructureRail structure={state.structure} />}
          <ReasoningRail
            steps={railSteps}
            phase={
              state.phase === "asking"
                ? "writing"
                : state.phase === "ready"
                  ? "done"
                  : state.phase === "error"
                    ? "error"
                    : "thinking"
            }
            questions={state.structure?.issues ?? []}
          />
        </>
      ) : null}
    </RefineRail>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {started ? (
        <header className="flex shrink-0 items-center gap-2.5 px-0.5 pb-3">
          <FileStack className="h-3.5 w-3.5 shrink-0 text-brand-navy/45" strokeWidth={1.75} />
          <p className="min-w-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
            {files.length} document{files.length === 1 ? "" : "s"} ·{" "}
            {(state.session?.pageCount ?? 0).toLocaleString()} pages
            {state.adding ? " · adding files…" : " · kept on this device"}
          </p>
          <div className="relative ml-auto flex shrink-0 items-center gap-3">
            {state.kbSave.status === "saved" && state.kbSave.message ? (
              <span className="hidden max-w-[280px] truncate text-[11px] text-muted-foreground sm:inline">
                {state.kbSave.message}
              </span>
            ) : null}
            {["queued", "converting", "embedding"].includes(state.kbSave.status) ? (
              <span className="hidden max-w-[280px] truncate text-[11px] text-muted-foreground sm:inline">
                {state.kbSave.message ?? "Workspace ingest is pending."}
              </span>
            ) : null}
            {state.kbSave.status === "error" ? (
              <span className="text-[11px] text-destructive" title={state.kbSave.message}>
                {state.kbSave.message ?? "Save failed"}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setWsName(files[0]?.name?.replace(/\.[^.]+$/, "") ?? "");
                setSaveOpen((v) => !v);
              }}
              disabled={["saving", "queued", "converting", "embedding"].includes(
                state.kbSave.status,
              )}
              className="text-[11.5px] font-medium text-brand-orange transition hover:underline disabled:opacity-50"
            >
              {state.kbSave.status === "saving"
                ? "Saving…"
                : state.kbSave.status === "queued"
                  ? "Queued"
                  : state.kbSave.status === "converting"
                    ? "Converting…"
                    : state.kbSave.status === "embedding"
                      ? "Embedding…"
                      : "Save workspace"}
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="shrink-0 text-[11.5px] font-medium text-muted-foreground transition hover:text-foreground"
            >
              Clear session
            </button>
            {saveOpen ? (
              <div className="absolute right-0 top-7 z-20 w-72 max-w-[calc(100vw-2rem)] rounded-sm border border-border bg-card p-4 shadow-lg">
                <p className="mb-2 text-[11px] font-semibold text-brand-navy">Save as workspace</p>
                <input
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  placeholder="Workspace name"
                  className="mb-2 h-[29px] w-full rounded border border-border bg-muted/40 px-2 text-[12px] outline-none focus:border-brand-blue/50 focus:bg-card"
                />
                <input
                  value={wsFolder}
                  onChange={(e) => setWsFolder(e.target.value)}
                  placeholder="Folder (optional)"
                  className="mb-2.5 h-[29px] w-full rounded border border-border bg-muted/40 px-2 text-[12px] outline-none focus:border-brand-blue/50 focus:bg-card"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSaveOpen(false)}
                    className="text-[11.5px] text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void saveWorkspace({
                        name: wsName.trim() || files[0]?.name || "Working set",
                        ...(wsFolder.trim() ? { folderId: wsFolder.trim() } : {}),
                      });
                      setSaveOpen(false);
                    }}
                    className="rounded bg-brand-orange px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </header>
      ) : null}

      {state.error && (
        <div className="mb-3 flex items-start gap-2.5 rounded-sm border border-destructive/25 bg-destructive/5 px-3.5 py-3">
          <AlertCircle className="mt-[1px] h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-foreground">{state.error}</p>
            {!state.session ? (
              <button
                type="button"
                onClick={reset}
                className="mt-1 text-[11.5px] font-medium text-brand-orange hover:underline"
              >
                Start over
              </button>
            ) : null}
          </div>
        </div>
      )}

      {!started ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto pb-6">
          <AnimatePresence initial={false}>
            <motion.div
              key="drop"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease: EASE }}
              className="w-full max-w-[880px]"
            >
              <DropPanel onStart={(f, i) => void start(f, i)} busy={false} />
              <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                Ask questions across a set of documents. Answers are cited to the page. The set is
                kept on this device until you clear it.
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
      ) : ingesting ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-0.5 py-1 sm:py-4">
          <div className="mx-auto w-full max-w-[880px]">
            <IngestProgress files={state.files} indexing={state.phase === "indexing"} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-sm border border-border bg-card">
          {desktopLayout ? (
            filesOpen ? (
              <aside className="hidden h-full w-[260px] shrink-0 border-r border-border bg-surface lg:flex lg:flex-col">
                {refine}
              </aside>
            ) : (
              <aside className="hidden h-full w-11 shrink-0 flex-col items-center border-r border-border bg-surface-strong py-2 lg:flex">
                <button
                  type="button"
                  onClick={() => setFilesOpen(true)}
                  aria-label="Open working set files"
                  className="grid h-8 w-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                </button>
                <span className="mt-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {files.length}
                </span>
              </aside>
            )
          ) : null}

          <ResizablePanelGroup
            key={wideLayout && readerOpen ? "results-reader" : "results"}
            id={wideLayout && readerOpen ? "working-set-results-reader" : "working-set-results"}
            orientation="horizontal"
            className="min-h-0 min-w-0 flex-1"
          >
            <ResizablePanel
              id="working-set-results"
              defaultSize="68%"
              minSize={desktopLayout ? "360px" : "0px"}
            >
              <div className="flex h-full min-h-0 min-w-0 flex-col bg-card">
            <div className="shrink-0 border-b border-border bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="inline-flex border border-border bg-surface-strong p-px"
                  role="group"
                  aria-label="Working set mode"
                >
                  {(["ask", "search"] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      aria-pressed={mode === m}
                      className={`px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        mode === m
                          ? "bg-card text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "ask" ? "Ask" : "Find passages"}
                    </button>
                  ))}
                </div>
                <span className="text-[11.5px] text-muted-foreground">
                  {mode === "ask"
                    ? "Answered only from your indexed documents"
                    : "Exact phrase, then every significant term"}
                </span>
                {mode === "ask" && state.hasPack ? (
                  <label className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={followUp}
                      onChange={(e) => setFollowUp(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border accent-[hsl(var(--brand-navy,0_0%_20%))]"
                    />
                    Follow up on these pages
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (desktopLayout) setFilesOpen(true);
                    else setRefineOpen(true);
                  }}
                  className={`ml-auto items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-[11.5px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    desktopLayout && filesOpen ? "hidden" : "inline-flex"
                  }`}
                >
                  {desktopLayout ? (
                    <PanelLeftOpen className="h-3 w-3" strokeWidth={1.75} />
                  ) : (
                    <SlidersHorizontal className="h-3 w-3" strokeWidth={1.75} />
                  )}
                  Working set
                </button>
              </div>

              <form
                className="mt-2.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <div className="flex min-h-11 items-center gap-1 rounded-sm border border-border/80 bg-card py-1 pl-3.5 pr-1 transition-[border-color,box-shadow] focus-within:border-brand-navy/40 focus-within:ring-2 focus-within:ring-brand-navy/[0.06]">
                  <Search
                    className="h-4 w-4 shrink-0 text-muted-foreground/70"
                    strokeWidth={1.75}
                  />
                  <input
                    value={state.query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={
                      mode === "ask"
                        ? "Ask a question about these documents…"
                        : "Search this set — docket numbers, experts, holdings…"
                    }
                    className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60"
                  />
                  <Button
                    type="submit"
                    disabled={!state.query.trim() || busy}
                    className="h-8 shrink-0 rounded-sm bg-brand-navy px-4 text-[12.5px] font-semibold text-primary-foreground transition-colors hover:bg-brand-navy/90 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {state.phase === "asking"
                      ? "Reading…"
                      : state.searching
                        ? "Searching…"
                        : mode === "ask"
                          ? "Ask"
                          : "Search"}
                  </Button>
                </div>
              </form>
            </div>

            <ResultsPane
              mode={mode}
              query={state.query}
              answer={state.answer}
              streaming={state.phase === "asking"}
              groups={visibleGroups}
              hits={state.hits}
              structure={state.structure}
              selected={state.selected}
              selectedRef={selectedRef}
              searching={state.searching}
              turns={state.turns}
              suggestions={suggestions}
              citePages={state.citePages}
              citeReport={state.citeReport}
              onOpen={openPage}
              onCite={(ref) => {
                const page = state.citePages.find((p) => p.ref === ref);
                if (page) {
                  openPage(page.fileId, page.page);
                  return;
                }
                const n = Number(String(ref).replace(/^S/i, ""));
                const hit = state.hits[n - 1];
                if (hit) openPage(hit.fileId, hit.page);
              }}
              onSuggest={runSuggestion}
              onJob={runJob}
            />
              </div>
            </ResizablePanel>
            {wideLayout && readerOpen && readerGroup ? (
              <>
                <ResizableHandle
                  withHandle
                  aria-label="Resize document reader"
                  className="z-10 w-1 bg-border/70 transition-colors hover:bg-brand-navy/20 data-[resize-handle-active]:bg-brand-navy/25"
                />
                <ResizablePanel
                  id="working-set-reader"
                  defaultSize="32%"
                  minSize="320px"
                  maxSize="52%"
                  collapsible
                  collapsedSize="0%"
                >
                  <aside className="h-full min-h-0 border-l border-border bg-card">
                    <DocumentReader
                      group={readerGroup}
                      page={readerPage}
                      query={state.query}
                      docType={docTypeOf(readerGroup.fileName, state.structure)}
                      pageTexts={state.pageTexts}
                      onPage={(p) => openPage(readerGroup.fileId, p)}
                      onClose={() => {
                        selectHit(null);
                        setReaderOpen(false);
                      }}
                    />
                  </aside>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>

          {overlayOpen && readerGroup ? (
            <div
              className="fixed inset-0 z-50 flex"
              role="dialog"
              aria-modal="true"
              aria-label="Document reader"
            >
              <button
                type="button"
                aria-label="Close reader"
                onClick={() => {
                  selectHit(null);
                  setReaderOpen(false);
                }}
                className="flex-1 bg-foreground/20 backdrop-blur-[1px]"
              />
              <div className="h-full w-[min(92vw,720px)] border-l border-border bg-card shadow-2xl">
                <DocumentReader
                  group={readerGroup}
                  page={readerPage}
                  query={state.query}
                  docType={docTypeOf(readerGroup.fileName, state.structure)}
                  pageTexts={state.pageTexts}
                  onPage={(p) => openPage(readerGroup.fileId, p)}
                  onClose={() => {
                    selectHit(null);
                    setReaderOpen(false);
                  }}
                />
              </div>
            </div>
          ) : null}

          {refineOpen ? (
            <div className="fixed inset-0 z-40 flex lg:hidden">
              <div className="w-[280px] max-w-[85vw] border-r border-border bg-card shadow-2xl">
                <div className="flex items-center justify-end px-2 py-2">
                  <button
                    type="button"
                    onClick={() => setRefineOpen(false)}
                    aria-label="Close working set"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>
                {refine}
              </div>
              <button
                type="button"
                aria-label="Close working set"
                onClick={() => setRefineOpen(false)}
                className="flex-1 bg-foreground/20 backdrop-blur-[1px]"
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
