import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";

import { countMatches, Highlight } from "./highlight";
import { fileFormat } from "./RefineRail";
import { formatRetrievedPage } from "@/lib/pile/page-format";
import type { PileFileHits } from "@/lib/pile/types";

export function DocumentReader({
  group,
  page,
  query,
  docType,
  pageTexts,
  onPage,
  onClose,
}: {
  group: PileFileHits;
  page: number;
  query: string;
  docType: string;
  pageTexts: Record<string, string>;
  onPage: (page: number) => void;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const available = useMemo(() => {
    if (group.pageCount > 0) return Array.from({ length: group.pageCount }, (_, i) => i + 1);
    const set = new Set<number>();
    for (const h of group.hits) set.add(h.page);
    for (const key of Object.keys(pageTexts)) {
      const [fid, p] = key.split(":");
      if (fid === group.fileId && p) set.add(Number(p));
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [group, pageTexts]);

  const hitPages = useMemo(
    () => Array.from(new Set(group.hits.map((h) => h.page))).sort((a, b) => a - b),
    [group],
  );

  const idx = available.indexOf(page);
  const raw = pageTexts[`${group.fileId}:${page}`] ?? pageTexts[`${group.fileName}:${page}`] ?? "";
  const text = raw ? formatRetrievedPage(raw) : "";
  const onThisPage = countMatches(text, query);

  const step = (delta: number) => {
    if (!available.length) return;
    const next = available[Math.min(available.length - 1, Math.max(0, idx + delta))];
    if (typeof next === "number") onPage(next);
  };
  const jumpHit = (delta: number) => {
    if (!hitPages.length) return;
    const pos = hitPages.findIndex((p) => p >= page);
    const base = pos === -1 ? hitPages.length - 1 : pos;
    const next = hitPages[Math.min(hitPages.length - 1, Math.max(0, base + delta))];
    if (typeof next === "number") onPage(next);
  };

  const copy = async () => {
    const sel = window.getSelection()?.toString();
    await navigator.clipboard.writeText(sel && sel.trim() ? sel : text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-start gap-2 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Document reader
          </p>
          <h2 className="mt-1 truncate text-[13.5px] font-semibold text-foreground">
            {group.fileName}
          </h2>
          <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {fileFormat(group.fileName)} · {group.pageCount} pages
          </p>
        </div>
        {docType !== "Unclassified" ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {docType}
          </span>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close reader"
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={idx <= 0}
            aria-label="Previous page"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <span className="rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11.5px] tabular-nums text-foreground">
            {page}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            / {group.pageCount}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={idx < 0 || idx >= available.length - 1}
            aria-label="Next page"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>

        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {onThisPage} on this page · {hitPages.length} page{hitPages.length === 1 ? "" : "s"} with
          hits
        </span>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => jumpHit(-1)}
            aria-label="Previous hit page"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => jumpHit(1)}
            aria-label="Next hit page"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => void copy()}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Copy className="h-3 w-3" strokeWidth={1.75} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {text ? (
          <p className="select-text whitespace-pre-wrap break-words text-[13.5px] font-[450] leading-[1.75] text-foreground">
            <Highlight text={text} query={query} />
          </p>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            {`${group.fileId}:${page}` in pageTexts || `${group.fileName}:${page}` in pageTexts
              ? "This page has no extracted text."
              : "Loading this page…"}
          </p>
        )}
      </div>
    </div>
  );
}
