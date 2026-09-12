import { useState } from "react";
import { ArrowLeft, LocateFixed, ScanSearch, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DepGraphNode } from "@/lib/pile/deposition-analysis";
import {
  graphEdgeKey,
  type GraphInsight,
  type MappedGraphInsights,
} from "@/lib/pile/graph-insights";
import type { ClassifiedGraphEdge } from "@/lib/pile/graph-view";
import { EvidenceBadge } from "./GraphEvidence";

export type GraphMapSelection = {
  id: string;
  kind: "insight" | "cluster" | "path";
  label: string;
  nodeIds: string[];
  edges: ClassifiedGraphEdge[];
};

export function MappedRelationships({
  edges,
  nodes,
  onEvidence,
}: {
  edges: ClassifiedGraphEdge[];
  nodes: Map<string, DepGraphNode>;
  onEvidence: (edge: ClassifiedGraphEdge) => void;
}) {
  const [all, setAll] = useState(false);
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-[11px] font-semibold text-foreground">
        Relationships to inspect · {edges.length}
      </p>
      {(all ? edges : edges.slice(0, 6)).map((edge) => (
        <button
          key={graphEdgeKey(edge)}
          type="button"
          onClick={() => onEvidence(edge)}
          className="block w-full rounded border border-border bg-background px-2.5 py-2 text-left text-xs hover:border-brand-navy/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-navy"
        >
          <span className="block font-medium text-foreground">
            {nodes.get(edge.from)?.label} → {nodes.get(edge.to)?.label}
          </span>
          <span className="mt-1 block text-muted-foreground">{edge.title || edge.label}</span>
          <span className="mt-1.5 block">
            <EvidenceBadge edge={edge} />
          </span>
        </button>
      ))}
      {edges.length > 6 && (
        <button
          type="button"
          className="text-xs font-medium text-brand-navy hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer relationships" : `Show all ${edges.length} relationships`}
        </button>
      )}
    </div>
  );
}

const KIND_LABEL = {
  shared: "Across transcripts",
  conflict: "Compare accounts",
  bridge: "Connecting groups",
  hub: "Key connections",
  group: "Evidence group",
  gap: "Source review",
};

export function GraphMappedInsights({
  result,
  selectedId,
  nodes,
  onMap,
  onEvidence,
  onClose,
}: {
  result: MappedGraphInsights;
  selectedId?: string;
  nodes: Map<string, DepGraphNode>;
  onMap: (insight: GraphInsight) => void;
  onEvidence: (edge: ClassifiedGraphEdge) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"patterns" | "review">(
    selectedId?.startsWith("gap:") || selectedId?.startsWith("conflict:") ? "review" : "patterns",
  );
  const isReview = (item: GraphInsight) => item.kind === "gap" || item.kind === "conflict";
  const displayed = result.insights.filter((item) => isReview(item) === (tab === "review"));
  return (
    <section aria-label="Mapped insights" className="p-3">
      <div className="flex items-center gap-2">
        <ScanSearch className="size-4 text-brand-navy" />
        <h3 className="flex-1 text-sm font-semibold">Mapped insights</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close mapped insights"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Patterns and review leads from the graph. Select one to frame its entities and inspect the
        evidence.
      </p>
      <p className="mt-2 rounded bg-muted px-2.5 py-2 text-[11px] text-foreground">
        {result.sourceMatched} of {result.analyzedEdges} relationships source matched · current
        filters
      </p>
      {result.limited && (
        <p role="status" className="mt-2 text-xs text-amber-800">
          Large graph: analyzed {result.analyzedNodes} of {result.totalNodes} entities and{" "}
          {result.analyzedEdges} of {result.totalEdges} relationships. Narrow the filters to examine
          the remainder.
        </p>
      )}
      <div
        role="group"
        aria-label="Insight category"
        className="my-3 flex gap-1 rounded border border-border p-0.5"
      >
        {(["patterns", "review"] as const).map((category) => (
          <Button
            key={category}
            size="sm"
            variant={tab === category ? "secondary" : "ghost"}
            className="h-7 flex-1 px-2 text-xs"
            aria-pressed={tab === category}
            onClick={() => setTab(category)}
          >
            {category === "patterns" ? "Patterns" : "Review"}{" "}
            <span className="text-muted-foreground">
              {result.insights.filter((item) => isReview(item) === (category === "review")).length}
            </span>
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        {displayed.map((insight) => {
          const selected = insight.id === selectedId;
          return (
            <article
              key={insight.id}
              className={`rounded-md border ${selected ? "border-brand-navy ring-1 ring-brand-navy/15" : "border-border"} bg-card p-2.5`}
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {KIND_LABEL[insight.kind]}
              </p>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Map insight: ${insight.title}`}
                onClick={() => onMap(insight)}
                className="mt-1 flex w-full items-start gap-2 text-left text-[13px] font-semibold leading-snug text-foreground hover:text-brand-navy"
              >
                <span className="flex-1">{insight.title}</span>
                <LocateFixed className="mt-0.5 size-3.5 shrink-0 text-brand-navy" />
              </button>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {insight.explanation}
              </p>
              <p className="mt-2 text-[11px] font-medium text-brand-navy">
                {insight.nodeIds.length} entities · {insight.edges.length} relationships
                {insight.files.length ? ` · ${insight.files.length} transcripts` : ""}
              </p>
              {selected && (
                <>
                  <p className="mt-2 border-t border-border pt-2 text-xs leading-relaxed text-foreground">
                    {insight.nextStep}
                  </p>
                  <MappedRelationships
                    key={insight.id}
                    edges={insight.edges}
                    nodes={nodes}
                    onEvidence={onEvidence}
                  />
                </>
              )}
            </article>
          );
        })}
        {!displayed.length && (
          <p className="rounded border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
            {tab === "patterns"
              ? "No structural patterns found in this view. Try including more entities or transcripts. Source-unmatched relationships are excluded from patterns."
              : "No source gaps or paired potential conflicts surfaced in this view. This does not establish completeness or consistency of the testimony."}
          </p>
        )}
      </div>
      {result.totalCandidates > result.insights.length && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Showing {result.insights.length} prioritized leads of {result.totalCandidates}. Narrow the
          graph filters to explore further.
        </p>
      )}
      <details className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          How insights are mapped
        </summary>
        <p className="mt-2 leading-relaxed">
          Computed from matched quotations, distinct transcript sources, direct neighbors, connected
          groups, and entities whose removal separates groups. Potential conflicts require both
          source passages. Source matching locates text; it does not validate the AI's
          interpretation. Patterns describe the extracted graph, not the complete record.
        </p>
      </details>
    </section>
  );
}

export function GraphMappedSelection({
  selection,
  nodes,
  onEvidence,
  onBack,
}: {
  selection: GraphMapSelection;
  nodes: Map<string, DepGraphNode>;
  onEvidence: (edge: ClassifiedGraphEdge) => void;
  onBack: () => void;
}) {
  return (
    <section aria-label="Mapped selection" className="p-3">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1 text-xs font-medium text-brand-navy"
      >
        <ArrowLeft className="size-3.5" />
        Mapped insights
      </button>
      <h3 className="text-sm font-semibold">{selection.label}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {selection.nodeIds.length} entities · {selection.edges.length} relationships
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {selection.kind === "path"
          ? "A route through the mapped relationships. Read each link in its original direction; a path does not establish causation or chronology."
          : "Grouped by graph connectivity. Inspect the relationships to assess what the testimony supports."}
      </p>
      <MappedRelationships
        key={selection.id}
        edges={selection.edges}
        nodes={nodes}
        onEvidence={onEvidence}
      />
    </section>
  );
}
