import { ChevronDown, Copy, Download, FileDown } from "lucide-react";
import { useState } from "react";

import { Highlight } from "./highlight";
import { docTypeOf } from "./RefineRail";
import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import type { Source } from "@/lib/chat-types";
import { downloadDocx } from "@/lib/memo-export";
import { citeLabelMap, rewriteCites, type CitePage, type CiteReport } from "@/lib/pile/cite-trust";
import { PILE_JOBS, type PileJobId } from "@/lib/pile/jobs";
import type { PileFileHits, PileHit, PileStructure } from "@/lib/pile/types";
import type { AskTurn } from "@/lib/use-pile";

const PREVIEW = 3;

function PassageRow({
  hit,
  query,
  active,
  onOpen,
}: {
  hit: PileHit;
  query: string;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`block w-full rounded-md px-2.5 py-2 text-left transition-colors ${
        active ? "bg-brand-orange-soft/40" : "hover:bg-muted/50"
      }`}
    >
      <span className="block font-mono text-[10.5px] tabular-nums text-muted-foreground">
        page {hit.page}
      </span>
      <span className="mt-0.5 block text-[12.5px] leading-[1.55] text-foreground/90">
        …<Highlight text={hit.snippet} query={query} />…
      </span>
    </button>
  );
}

function GroupCard({
  group,
  query,
  selected,
  docType,
  onOpen,
}: {
  group: PileFileHits;
  query: string;
  selected: string | null;
  docType: string;
  onOpen: (fileId: string, page: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.hits : group.hits.slice(0, PREVIEW);
  const rest = group.hits.length - shown.length;

  return (
    <section className="border-b border-border/70 px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {group.fileName}
        </h3>
        {docType !== "Unclassified" ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {docType}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {group.hits.length || "no"} {group.hits.length === 1 ? "hit" : "hits"}
        </span>
      </div>

      {group.hits.length ? (
        <div className="mt-1.5 space-y-0.5">
          {shown.map((h) => (
            <PassageRow
              key={`${h.fileId}:${h.page}:${h.snippet.slice(0, 16)}`}
              hit={h}
              query={query}
              active={selected === `${h.fileId}:${h.page}`}
              onOpen={() => onOpen(h.fileId, h.page)}
            />
          ))}
          {rest > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-2.5 pt-1 text-[11.5px] font-medium text-brand-orange hover:underline"
            >
              Show {rest} more passage{rest === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 px-2.5 text-[11.5px] text-muted-foreground">
          No matching passage in this document.
        </p>
      )}
    </section>
  );
}

function sourcesFromPages(pages: CitePage[]): Source[] {
  return pages.map((p) => ({
    ref: p.ref,
    citation: `${p.fileName} p. ${p.page}`,
    authority: p.fileName,
    source_type: "working_set",
    content: (p.text ?? "").slice(0, 4000),
  }));
}

function AnswerActions({
  text,
  title,
  citePages,
}: {
  text: string;
  title: string;
  citePages: CitePage[];
}) {
  const [copied, setCopied] = useState(false);
  const labeled = citePages.length ? rewriteCites(text, citePages) : text;
  const copy = async () => {
    await navigator.clipboard.writeText(labeled);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const downloadMd = () => {
    const blob = new Blob([labeled], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w]+/g, "-").slice(0, 48) || "answer"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const downloadWord = () => {
    void downloadDocx({
      question: title,
      answer: labeled,
      sources: sourcesFromPages(citePages),
    });
  };
  return (
    <div className="ml-auto flex items-center gap-1">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Copy className="h-3 w-3" strokeWidth={1.75} />
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        onClick={downloadMd}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="h-3 w-3" strokeWidth={1.75} />
        Markdown
      </button>
      <button
        type="button"
        onClick={downloadWord}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <FileDown className="h-3 w-3" strokeWidth={1.75} />
        Word
      </button>
    </div>
  );
}

function CiteStrip({ report }: { report: CiteReport }) {
  return (
    <div className="mt-2 space-y-1.5">
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {report.pagesRead} page{report.pagesRead === 1 ? "" : "s"} across {report.filesRead}
        {report.filesTotal > report.filesRead ? ` of ${report.filesTotal}` : ""} document
        {report.filesRead === 1 ? "" : "s"}
        {report.cites.length
          ? ` · ${report.verified} verified cite${report.verified === 1 ? "" : "s"}`
          : ""}
        {report.unverified ? ` · ${report.unverified} unverified` : ""}
      </p>
      {report.ocrUsed || report.garbledUsed ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-900">
          {report.garbledUsed
            ? "Some cited pages look like OCR noise — open the page and confirm the quote."
            : "Some cited pages were recovered by OCR. Confirm the quote on the page."}
        </p>
      ) : null}
      {report.unverified ? (
        <p className="text-[11.5px] text-muted-foreground">
          {report.unverified} cite{report.unverified === 1 ? "" : "s"} lacked a verifiable quoted
          span or did not match the cited page.
        </p>
      ) : null}
    </div>
  );
}

function PriorTurn({
  turn,
  onCite,
  citeLabels,
}: {
  turn: AskTurn;
  onCite: (ref: string) => void;
  citeLabels?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-border/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{turn.query}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="px-4 pb-3">
          <AnswerMarkdown text={turn.answer} onCite={onCite} citeLabels={citeLabels} />
        </div>
      ) : null}
    </section>
  );
}

export function ResultsPane({
  mode,
  query,
  answer,
  streaming,
  groups,
  hits,
  structure,
  selected,
  selectedRef,
  searching,
  turns,
  suggestions,
  citePages,
  citeReport,
  onOpen,
  onCite,
  onSuggest,
  onJob,
}: {
  mode: "search" | "ask";
  query: string;
  answer: string;
  streaming: boolean;
  groups: PileFileHits[];
  hits: PileHit[];
  structure: PileStructure | null;
  selected: string | null;
  selectedRef: string | null;
  searching: boolean;
  turns: AskTurn[];
  suggestions: string[];
  citePages: CitePage[];
  citeReport: CiteReport | null;
  onOpen: (fileId: string, page: number) => void;
  onCite: (ref: string) => void;
  onSuggest: (question: string) => void;
  onJob?: (id: PileJobId) => void;
}) {
  const matched = groups.filter((g) => g.hits.length);
  const passages = groups.reduce((n, g) => n + g.hits.length, 0);
  const idle = !searching && !answer && !groups.length;
  const labels = citeLabelMap(citePages);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const collapseSources = Boolean(answer) && groups.length > 0;

  return (
    <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto">
      {mode === "ask" && onJob && !streaming ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border/70 px-4 py-2.5">
          {PILE_JOBS.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onJob(job.id)}
              className="rounded-full border border-border bg-muted/30 px-3 py-1 text-[11.5px] font-medium text-foreground transition hover:border-brand-navy/30 hover:bg-card"
            >
              {job.label}
            </button>
          ))}
        </div>
      ) : null}

      {turns.length ? (
        <div className="border-b border-border/70">
          <p className="px-4 pt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Earlier questions
          </p>
          {turns.map((t) => (
            <PriorTurn key={t.id} turn={t} onCite={onCite} citeLabels={labels} />
          ))}
        </div>
      ) : null}

      {answer ? (
        <section className="border-b border-border/70 px-4 py-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Answer
            </span>
            <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-700">
              {citeReport
                ? `${citeReport.pagesRead} page${citeReport.pagesRead === 1 ? "" : "s"}`
                : `${hits.length} grounded passage${hits.length === 1 ? "" : "s"}`}
            </span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              across {citeReport?.filesRead ?? matched.length} document
              {(citeReport?.filesRead ?? matched.length) === 1 ? "" : "s"}
            </span>
            {!streaming ? (
              <AnswerActions text={answer} title={query} citePages={citePages} />
            ) : null}
          </div>
          <AnswerMarkdown
            text={answer}
            streaming={streaming}
            selectedRef={selectedRef}
            onCite={onCite}
            citeLabels={labels}
          />
          {!streaming && citeReport ? <CiteStrip report={citeReport} /> : null}
        </section>
      ) : null}

      {searching ? (
        <p className="px-4 py-4 text-[12.5px] text-muted-foreground">Searching the index…</p>
      ) : null}

      {groups.length ? (
        <>
          {collapseSources ? (
            <button
              type="button"
              onClick={() => setSourcesOpen((v) => !v)}
              className="sticky top-0 z-[1] flex w-full items-center gap-2 border-b border-border/70 bg-card/95 px-4 py-2 text-left backdrop-blur"
            >
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                Sources ({passages})
              </span>
              <ChevronDown
                className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform ${sourcesOpen ? "rotate-180" : ""}`}
              />
            </button>
          ) : (
            <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border/70 bg-card/95 px-4 py-2 backdrop-blur">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {passages} passage{passages === 1 ? "" : "s"} across {matched.length} of{" "}
                {groups.length} documents
              </span>
            </div>
          )}
          {!collapseSources || sourcesOpen
            ? groups.map((g) => (
                <GroupCard
                  key={g.fileId}
                  group={g}
                  query={query}
                  selected={selected}
                  docType={docTypeOf(g.fileName, structure)}
                  onOpen={onOpen}
                />
              ))
            : null}
        </>
      ) : idle ? (
        <div className="px-4 py-5">
          <p className="text-[13px] font-medium text-foreground">
            {mode === "ask"
              ? "Ask a question — answers stay on the page and cite the source."
              : "Find a phrase, docket number, or name across every document."}
          </p>
          {suggestions.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {suggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onSuggest(q)}
                  className="rounded-full border border-border bg-muted/30 px-3 py-1.5 text-left text-[12px] text-foreground transition hover:border-brand-navy/30 hover:bg-card"
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
