import { ArrowRight, BookOpen, Check, Download, X } from "lucide-react";
import type { DepGraphNode } from "@/lib/pile/deposition-analysis";
import type { ClassifiedGraphEdge } from "@/lib/pile/graph-view";
import { Button } from "@/components/ui/button";
import { hasMatchedGraphEvidence } from "@/lib/pile/graph-insights";

export function EvidenceBadge({ edge }: { edge: ClassifiedGraphEdge }) {
  const matched = hasMatchedGraphEvidence(edge);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${matched ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
    >
      {matched ? <Check className="size-3" /> : <BookOpen className="size-3" />}
      {matched ? "Source matched" : "Needs review"}
    </span>
  );
}

export function GraphEvidencePanel({
  edge,
  nodes,
  onCite,
  onClose,
}: {
  edge: ClassifiedGraphEdge;
  nodes: Map<string, DepGraphNode>;
  onCite: (cite: string, fileName?: string) => void;
  onClose: () => void;
}) {
  const evidence = edge.pairedEvidence ?? [
    {
      quote: edge.quote ?? "",
      cite: edge.cite,
      fileName: edge.fileName ?? "",
      evidenceStatus: edge.evidenceStatus,
    },
  ];
  return (
    <section className="space-y-4 p-4" aria-label="Relationship evidence">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Relationship evidence</h3>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Close relationship evidence"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold leading-snug">
          {nodes.get(edge.from)?.label ?? edge.from}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ArrowRight className="size-3.5" />
          {edge.title || edge.label}
        </p>
        <p className="text-sm font-semibold leading-snug">{nodes.get(edge.to)?.label ?? edge.to}</p>
        <EvidenceBadge edge={edge} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Source matched means the quotation was located in the named transcript. The relationship and
        any potential conflict remain interpretations for your review.
      </p>
      {evidence.map((source, i) => (
        <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-3">
          <p className="break-words text-xs font-semibold">
            {source.fileName || "Source not identified"}
          </p>
          {source.quote ? (
            <blockquote className="border-l-2 border-brand-navy/40 pl-3 text-[13px] leading-relaxed">
              “{source.quote}”
            </blockquote>
          ) : (
            <p className="text-xs text-muted-foreground">
              No supporting quotation was stored for this relationship. Re-run analysis to extract
              source evidence.
            </p>
          )}
          {source.evidenceStatus === "source_matched" && source.cite && source.fileName ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => onCite(source.cite, source.fileName)}
            >
              <BookOpen className="size-3" />
              Open {source.cite}
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {source.evidenceStatus === "source_matched"
                ? "Source text matched; reliable line numbering is unavailable."
                : "This source has not been verified against the transcript."}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

export function GraphRelationshipList({
  edges,
  nodes,
  search,
  onSelect,
}: {
  edges: ClassifiedGraphEdge[];
  nodes: Map<string, DepGraphNode>;
  search: string;
  onSelect: (edge: ClassifiedGraphEdge) => void;
}) {
  const needle = search.trim().toLowerCase();
  const rows = edges.filter((e) =>
    [
      nodes.get(e.from)?.label,
      nodes.get(e.to)?.label,
      e.label,
      e.title,
      e.fileName,
      e.quote,
      ...(e.pairedEvidence?.flatMap((source) => [source.fileName, source.quote]) ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
  const download = () => {
    const quoteCell = (v: string) =>
      `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
    const csv = [
      [
        "From",
        "Relationship",
        "To",
        "Evidence",
        "Transcript",
        "Citation",
        "Quotation",
        "Comparison transcript",
        "Comparison citation",
        "Comparison quotation",
      ],
      ...rows.map((e) => [
        nodes.get(e.from)?.label ?? e.from,
        e.title || e.label,
        nodes.get(e.to)?.label ?? e.to,
        e.evidenceStatus === "source_matched"
          ? "Source matched; interpretation requires review"
          : "Needs review",
        e.fileName ?? "",
        e.cite,
        e.quote ?? "",
        e.pairedEvidence?.[1]?.fileName ?? "",
        e.pairedEvidence?.[1]?.cite ?? "",
        e.pairedEvidence?.[1]?.quote ?? "",
      ]),
    ]
      .map((row) => row.map(quoteCell).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "deposition-relationships.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="min-w-0 flex-1 overflow-auto rounded-md border border-border bg-card"
      aria-label="Relationship list"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <span className="text-xs font-medium">{rows.length} relationships</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!rows.length}
          onClick={download}
        >
          <Download className="size-3.5" />
          Export CSV
        </Button>
      </div>
      {!rows.length ? (
        <p className="p-6 text-sm text-muted-foreground">
          No relationships match these filters. Try another search or reset the filters.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((edge, i) => (
            <li key={i}>
              <button
                className="w-full space-y-2 px-4 py-3 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy"
                onClick={() => onSelect(edge)}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <span className="font-semibold">{nodes.get(edge.from)?.label ?? edge.from}</span>
                  <span className="text-muted-foreground">{edge.title || edge.label}</span>
                  <span className="font-semibold">{nodes.get(edge.to)?.label ?? edge.to}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <EvidenceBadge edge={edge} />
                  <span className="truncate text-xs text-muted-foreground">
                    {edge.fileName || "Source not identified"}
                    {edge.cite ? ` · ${edge.cite}` : ""}
                  </span>
                </div>
                {edge.quote ? (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    “{edge.quote}”
                  </p>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
