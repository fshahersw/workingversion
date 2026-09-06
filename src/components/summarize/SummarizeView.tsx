import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ChevronDown, FileStack, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DocumentReader } from "./DocumentReader";
import { DropPanel } from "./DropPanel";
import { IngestProgress } from "./IngestProgress";
import { ReasoningRail } from "./ReasoningRail";
import { docTypeOf, fileFormat, RefineRail } from "./RefineRail";
import { SavedDocsPanel } from "./SavedDocsPanel";
import { ResultsPane } from "./ResultsPane";
import { StructureRail } from "./StructureRail";
import { Button } from "@/components/ui/button";
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
  const { state, start, addFiles, search, ask, reset, loadPage, saveToKb, setQuery, selectHit } =
    useSharedPile();
  const [mode, setMode] = useState<Mode>("ask");
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [formats, setFormats] = useState<Set<string>>(new Set());
  const [restrictIds, setRestrictIds] = useState<Set<string>>(new Set());
  const [followUp, setFollowUp] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const started = state.phase !== "idle";
  const ingesting = state.phase === "reading" || state.phase === "indexing";
  const busy = ingesting || state.phase === "asking" || state.adding;
  const files = state.session?.files ?? [];

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
  const overlayOpen = !!selectedFile;

  useEffect(() => {
    if (!dockFile) return;
    void loadPage(dockFile.id, readerPage);
  }, [dockFile?.id, readerPage, loadPage]);

  const openPage = (fileId: string, page: number) => {
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
      <SavedDocsPanel reloadKey={`${state.kbSave.status}:${state.kbSave.message ?? ""}`} />
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
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {state.kbSave.status === "saved" && state.kbSave.message ? (
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {state.kbSave.message}
              </span>
            ) : null}
            {state.kbSave.status === "error" ? (
              <span className="text-[11px] text-destructive" title={state.kbSave.message}>
                {state.kbSave.message ?? "Save failed"}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void saveToKb()}
              disabled={state.kbSave.status === "saving"}
              title="Persist this working set to your searchable documents"
              className="text-[11.5px] font-medium text-brand-orange transition hover:underline disabled:opacity-50"
            >
              {state.kbSave.status === "saving"
                ? "Saving…"
                : state.kbSave.status === "saved"
                  ? "Saved ✓"
                  : "Save to my documents"}
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="shrink-0 text-[11.5px] font-medium text-muted-foreground transition hover:text-foreground"
            >
              Clear session
            </button>
          </div>
        </header>
      ) : null}

      {state.error && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-3">
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
              className="w-full max-w-[760px]"
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <IngestProgress files={state.files} indexing={state.phase === "indexing"} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[236px_minmax(0,1fr)_minmax(360px,38%)]">
          <aside className="hidden min-h-0 border-r border-border/70 bg-card lg:flex lg:flex-col">
            {refine}
          </aside>

          <div className="flex min-h-0 min-w-0 flex-col bg-card">
            <div className="shrink-0 border-b border-border/70 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg bg-muted p-0.5">
                  {(["ask", "search"] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`rounded-[7px] px-3 py-1 text-[12px] font-medium transition-colors ${
                        mode === m
                          ? "bg-card text-foreground shadow-sm"
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
                  onClick={() => setRefineOpen(true)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground lg:hidden"
                >
                  <SlidersHorizontal className="h-3 w-3" strokeWidth={1.75} />
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
                <div className="flex h-11 items-center gap-1 rounded-xl border border-border/80 bg-card pl-3.5 pr-1 shadow-sm transition-all focus-within:border-brand-navy/30 focus-within:ring-4 focus-within:ring-brand-navy/[0.06]">
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
                    className="h-8 shrink-0 rounded-lg bg-brand-navy px-4 text-[12.5px] font-semibold text-primary-foreground transition-all hover:bg-brand-navy/90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
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

          {readerGroup ? (
            <>
              <aside className="hidden min-h-0 border-l border-border/70 xl:block">
                <DocumentReader
                  group={readerGroup}
                  page={readerPage}
                  query={state.query}
                  docType={docTypeOf(readerGroup.fileName, state.structure)}
                  pageTexts={state.pageTexts}
                  onPage={(p) => openPage(readerGroup.fileId, p)}
                />
              </aside>
              {overlayOpen ? (
                <div className="fixed inset-0 z-40 flex xl:hidden">
                  <button
                    type="button"
                    aria-label="Close reader"
                    onClick={() => selectHit(null)}
                    className="flex-1 bg-foreground/20 backdrop-blur-[1px]"
                  />
                  <div className="w-full max-w-[640px] border-l border-border bg-card shadow-2xl">
                    <DocumentReader
                      group={readerGroup}
                      page={readerPage}
                      query={state.query}
                      docType={docTypeOf(readerGroup.fileName, state.structure)}
                      pageTexts={state.pageTexts}
                      onPage={(p) => openPage(readerGroup.fileId, p)}
                      onClose={() => selectHit(null)}
                    />
                  </div>
                </div>
              ) : null}
            </>
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
