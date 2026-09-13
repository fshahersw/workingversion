import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Loader2,
  LocateFixed,
  Minus,
  Plus,
  Search,
  List,
  Network,
  SlidersHorizontal,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import { GraphEvidencePanel, GraphRelationshipList, EvidenceBadge } from "./GraphEvidence";
import {
  GraphMappedInsights,
  GraphMappedSelection,
  type GraphMapSelection,
} from "./GraphMappedInsights";
import { useGraphCamera } from "./useGraphCamera";

import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Close as PopoverClose } from "@radix-ui/react-popover";
import { nodeFileMap, witnessColumns } from "@/lib/pile/dep-intel";
import { displayCite, type DepAnalysis, type DepGraphNode } from "@/lib/pile/deposition-analysis";
import { CLUSTER_PALETTE, clusterGraph } from "@/lib/pile/graph-cluster";
import { enumeratePaths, rankPaths, serialisePath } from "@/lib/pile/graph-paths";
import { graphQuestion, type GraphAskKind } from "@/lib/pile/graph-questions";
import {
  graphEdgeKey,
  hasMatchedGraphEvidence,
  mappedGraphInsights,
  type GraphInsight,
} from "@/lib/pile/graph-insights";
import type { PileHit } from "@/lib/pile/types";
import {
  conflictEdgesFromAnalysis,
  corroborationEdgesFromAnalysis,
  hopSet,
  KIND_HEX,
  layoutGraph,
  loadGraphView,
  saveGraphView,
  shouldShowEdgeLabel,
  shouldShowNodeLabel,
  visibleGraph,
  DEFAULT_GRAPH_VIEW,
  type ClassifiedGraphEdge,
  type GraphViewSettings,
} from "@/lib/pile/graph-view";
import { wrapGraphLabel } from "@/lib/pile/knowledge-graph-view";

export type GraphFocus = { id: string; n: number };

/**
 * One-click analyses over the selected node. Each lens changes what the
 * canvas emphasises and which question "Ask" sends; nothing leaves the graph.
 */
type Lens = "connections" | "paths" | "conflicts" | "relationships" | "witnesses";

const LENSES: { id: Lens; label: string; hint: string; multiOnly?: boolean }[] = [
  { id: "connections", label: "Connections", hint: "Everything one step away" },
  { id: "paths", label: "Paths", hint: "Two steps out, with the routes to shared entities" },
  {
    id: "relationships",
    label: "Relationships",
    hint: "Every link labelled with what the witness said",
  },
  {
    id: "conflicts",
    label: "Conflicts",
    hint: "Only contradictions and corroboration around this node",
  },
  {
    id: "witnesses",
    label: "Across witnesses",
    hint: "Who else mentions this, coloured by witness",
    multiOnly: true,
  },
];

const LENS_ASK: Record<Lens, GraphAskKind> = {
  connections: "testimony",
  paths: "relationships",
  relationships: "relationships",
  conflicts: "conflicts",
  witnesses: "witnesses",
};

/** Below this many CSS px of component width the dossier docks under the canvas. */
const DOSSIER_SIDE_MIN_WIDTH = 800;

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const KIND_LABEL: Record<DepGraphNode["kind"], string> = {
  person: "Person",
  org: "Org",
  doc: "Doc",
  theme: "Theme",
  event: "Event",
};

const KIND_DOT: Record<DepGraphNode["kind"], string> = {
  person: "bg-brand-navy",
  org: "bg-brand-orange",
  doc: "bg-slate-500",
  theme: "bg-emerald-700",
  event: "bg-amber-700",
};

const EDGE_HEX = {
  factual: "#94a3b8",
  on: "#1e3a5f",
  contradicts: "#b42318",
  corroborates: "#047857",
};

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, lane: number): string {
  const mx = (a.x + b.x) / 2;
  const lift = (Math.abs(a.y - b.y) < 8 ? 40 : 24) + Math.floor(lane / 2) * 26;
  const my = (a.y + b.y) / 2 + (lane % 2 === 0 ? -lift : lift);
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

export function KnowledgeGraph({
  analysis,
  onCite,
  multi,
  transcripts,
  onAsk,
  answer,
  asking,
  hits,
  focus: focusReq,
}: {
  analysis: DepAnalysis;
  onCite: (cite: string, fileName?: string) => void;
  multi?: boolean;
  transcripts?: { fileId: string; fileName: string; witness?: string | null }[];
  /** Runs an Ask; the answer is shown inside the graph's dossier. */
  onAsk?: (q: string) => void;
  /** Current Ask answer and state, rendered inline when the graph asked. */
  answer?: string;
  asking?: boolean;
  /** Retrieved passages behind `answer`; [S#] refs resolve to their page:line. */
  hits?: PileHit[];
  focus?: GraphFocus | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rootWidth = useElementWidth(rootRef);
  const dossierAside = rootWidth === 0 || rootWidth >= DOSSIER_SIDE_MIN_WIDTH;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(focusReq?.id ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [selectedEdge, setSelectedEdge] = useState<ClassifiedGraphEdge | null>(null);
  const [view, setView] = useState<GraphViewSettings>(() => loadGraphView());
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const [mapped, setMapped] = useState<GraphMapSelection | null>(null);
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [lens, setLens] = useState<Lens>("connections");
  /** The question this graph last sent to Ask; the inline answer belongs to it. */
  const [askedHere, setAskedHere] = useState<{ nodeId: string; question: string } | null>(null);
  const filterKey = JSON.stringify([
    view.kinds,
    view.files,
    view.sharedOnly,
    view.edges,
    view.hideIsolated,
    view.minDegree,
    view.minConfidence,
    view.evidence,
  ]);

  useEffect(() => {
    saveGraphView(view);
  }, [view]);

  useEffect(() => {
    setSelectedEdge(null);
    setMapped(null);
  }, [analysis, filterKey]);

  useEffect(() => {
    if (!focusReq) return;
    setActive(focusReq.id);
    setMapped(null);
    setSelectedEdge(null);
    setInsightsOpen(false);
    setMode("graph");
    setView((current) => ({ ...current, minDegree: 0, sharedOnly: false }));
  }, [focusReq]);

  // Lenses drive hop depth and colouring; the reader never has to find the
  // matching dropdowns.
  useEffect(() => {
    setView((current) => ({
      ...current,
      hops: lens === "paths" ? 2 : 1,
      colorBy:
        lens === "witnesses"
          ? "witness"
          : current.colorBy === "witness"
            ? "cluster"
            : current.colorBy,
    }));
  }, [lens]);

  const synthetic = useMemo(
    () => [...conflictEdgesFromAnalysis(analysis), ...corroborationEdgesFromAnalysis(analysis)],
    [analysis],
  );
  // Attribute named witnesses and directly source-matched relationships only.
  const fileMap = useMemo(() => {
    const cols = witnessColumns(
      analysis,
      (transcripts ?? []).map((t) => ({ fileName: t.fileName, witness: t.witness ?? null })),
    );
    return nodeFileMap(analysis, cols);
  }, [analysis, transcripts]);
  const visible = useMemo(
    () => visibleGraph(analysis, synthetic, view, (node) => fileMap.get(node.id) ?? []),
    [analysis, synthetic, view, fileMap],
  );
  const clusters = useMemo(
    () => clusterGraph(visible, (id) => visible.files.get(id) ?? []),
    [visible],
  );
  const clusterOf = useMemo(() => {
    const map = new Map<string, string>();
    clusters.forEach((cluster, index) => {
      for (const id of cluster.nodeIds)
        map.set(id, CLUSTER_PALETTE[index % CLUSTER_PALETTE.length]!);
    });
    return map;
  }, [clusters]);
  const layout = useMemo(
    () => layoutGraph(visible.nodes, visible.edges, view.layout, clusters, visible.files),
    [visible.nodes, visible.edges, visible.files, view.layout, clusters],
  );
  const fileColor = useMemo(() => {
    const ordered = transcripts?.length
      ? transcripts.map((transcript) => transcript.fileName)
      : [...new Set([...visible.files.values()].flat())].sort();
    return new Map(
      ordered.map((file, index) => [file, CLUSTER_PALETTE[index % CLUSTER_PALETTE.length]!]),
    );
  }, [transcripts, visible.files]);
  const byId = useMemo(() => new Map(layout.items.map((item) => [item.id, item])), [layout.items]);
  const nodeById = useMemo(
    () => new Map(visible.nodes.map((node) => [node.id, node])),
    [visible.nodes],
  );
  const insights = useMemo(
    () => mappedGraphInsights(visible.nodes, visible.edges),
    [visible.nodes, visible.edges],
  );
  const selectNode = (id: string | null) => {
    setActive(id);
    setMapped(null);
    setSelectedEdge(null);
    setInsightsOpen(false);
  };
  const mapGroup = (selection: GraphMapSelection) => {
    if (mapped?.id === selection.id && !selectedEdge) fit();
    setMapped(selection);
    setActive(null);
    setHover(null);
    setSelectedEdge(null);
    setSearch("");
    setMode("graph");
    setInsightsOpen(selection.kind === "insight");
  };
  const mapInsight = (insight: GraphInsight) =>
    mapGroup({
      id: insight.id,
      kind: "insight",
      label: insight.title,
      nodeIds: insight.nodeIds,
      edges: insight.edges,
    });
  const showAll = useCallback(() => {
    setActive(null);
    setHover(null);
    setMapped(null);
    setSelectedEdge(null);
  }, []);
  const frameIds = useMemo(
    () =>
      selectedEdge
        ? [selectedEdge.from, selectedEdge.to]
        : (mapped?.nodeIds ??
          (active ? [...(hopSet(active, visible.edges, view.hops) ?? [])] : null)),
    [selectedEdge, mapped, active, visible.edges, view.hops],
  );
  const {
    camera,
    move,
    pan,
    zoom: zoomBy,
    fit,
    stop,
  } = useGraphCamera(
    viewportRef,
    layout.items,
    frameIds,
    mode === "graph" && !!analysis.graph.nodes.length,
  );
  const mappedEdges = useMemo(
    () =>
      selectedEdge
        ? new Set([graphEdgeKey(selectedEdge)])
        : mapped
          ? new Set(mapped.edges.map(graphEdgeKey))
          : null,
    [selectedEdge, mapped],
  );
  useEffect(() => {
    if (active && !nodeById.has(active)) setActive(null);
  }, [active, nodeById]);
  const focusId = active ?? hover;
  const hasFocus = !!(selectedEdge || mapped || focusId);
  const linked = useMemo(
    () =>
      selectedEdge
        ? new Set([selectedEdge.from, selectedEdge.to])
        : mapped
          ? new Set(mapped.nodeIds)
          : (hopSet(focusId, visible.edges, view.hops) ??
            new Set(visible.nodes.map((node) => node.id))),
    [selectedEdge, mapped, focusId, visible.edges, visible.nodes, view.hops],
  );
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return new Set(visible.nodes.map((node) => node.id));
    return new Set(
      visible.nodes
        .filter((node) => node.label.toLowerCase().includes(needle))
        .map((node) => node.id),
    );
  }, [search, visible.nodes]);
  const sharedIds = useMemo(
    () =>
      visible.nodes
        .filter((node) => (visible.files.get(node.id) ?? []).length > 1)
        .map((node) => node.id),
    [visible.files, visible.nodes],
  );
  const paths = useMemo(() => {
    if (!active) return [];
    return rankPaths(
      enumeratePaths(
        visible.edges.filter((edge) => hasMatchedGraphEvidence(edge) && !edge.pairedEvidence),
        [active],
        sharedIds,
      ),
    ).slice(0, 6);
  }, [active, sharedIds, visible.edges]);
  const conflictIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visible.edges) {
      if (edge.class !== "contradicts") continue;
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [visible.edges]);
  const agreeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visible.edges) {
      if (edge.class !== "corroborates") continue;
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [visible.edges]);

  // Manual gestures stop an automatic flight immediately. (Wheel is bound
  // natively in the effect below with { passive: false } so preventDefault works
  // and does not spam the console via React's passive root wheel listener.)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, a"))
      return;
    stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    pan(event.clientX - dragging.x, event.clientY - dragging.y);
    setDragging({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(1.25);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomBy(1 / 1.25);
      } else if (event.key === "0") {
        event.preventDefault();
        fit();
      } else if (event.key === "1") {
        event.preventDefault();
        move({ x: 0, y: 0, k: 1 });
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : 1;
      pan(-event.deltaX * scale, -event.deltaY * scale);
    };
    node.addEventListener("keydown", onKey);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("wheel", onWheel);
    };
  }, [fit, move, zoomBy, pan]);

  const focusNode = active ? nodeById.get(active) : null;
  const focusLaid = active ? byId.get(active) : null;
  const focusEdges = active
    ? visible.edges.filter((edge) => edge.from === active || edge.to === active)
    : [];
  const nodeAccent = (id: string, kind: DepGraphNode["kind"]): string => {
    if (view.colorBy === "cluster") return clusterOf.get(id) ?? KIND_HEX[kind];
    if (view.colorBy === "witness") {
      const files = visible.files.get(id) ?? [];
      if (files.length > 1) return "#0f172a";
      return fileColor.get(files[0] ?? "") ?? KIND_HEX[kind];
    }
    return KIND_HEX[kind];
  };
  const conflictCount = visible.edges.filter((edge) => edge.class === "contradicts").length;
  const agreeCount = visible.edges.filter((edge) => edge.class === "corroborates").length;
  const fits = camera.k >= 0.98 && camera.x > -8 && camera.y > -8 && camera.x < 40 && camera.y < 40;

  const kindCounts = (Object.keys(KIND_LABEL) as DepGraphNode["kind"][]).map((kind) => ({
    kind,
    n: visible.nodes.filter((node) => node.kind === kind).length,
  }));

  const filters = (
    <div className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(KIND_LABEL) as DepGraphNode["kind"][]).map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={view.kinds[kind]}
          onClick={() =>
            setView((current) => ({
              ...current,
              kinds: { ...current.kinds, [kind]: !current.kinds[kind] },
            }))
          }
          className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
            view.kinds[kind]
              ? "border-brand-navy bg-brand-navy text-white"
              : "border-border bg-card text-muted-foreground"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[kind]}`} />
          {KIND_LABEL[kind]} {kindCounts.find((row) => row.kind === kind)?.n ?? 0}
        </button>
      ))}
      <label className="ml-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
        Min degree
        <input
          type="range"
          min={0}
          max={5}
          value={view.minDegree}
          onChange={(event) =>
            setView((current) => ({ ...current, minDegree: Number(event.target.value) }))
          }
        />
      </label>
      <select
        value={view.layout}
        onChange={(event) =>
          setView((current) => ({
            ...current,
            layout: event.target.value as GraphViewSettings["layout"],
          }))
        }
        className="h-7 border border-border bg-card px-2 text-[11px]"
        aria-label="Graph layout"
      >
        <option value="kind">Layout: kind</option>
        <option value="cluster">Layout: cluster</option>
        <option value="witness">Layout: witness</option>
        <option value="force">Layout: force</option>
      </select>
      <select
        value={view.colorBy}
        onChange={(event) =>
          setView((current) => ({
            ...current,
            colorBy: event.target.value as GraphViewSettings["colorBy"],
          }))
        }
        className="h-7 border border-border bg-card px-2 text-[11px]"
        aria-label="Colour by"
      >
        <option value="kind">Colour: kind</option>
        <option value="cluster">Colour: cluster</option>
        {multi ? <option value="witness">Colour: witness</option> : null}
      </select>
      {multi ? (
        <button
          type="button"
          aria-pressed={view.sharedOnly}
          onClick={() => setView((current) => ({ ...current, sharedOnly: !current.sharedOnly }))}
          className={`border px-2 py-1 text-[10.5px] ${view.sharedOnly ? "border-brand-navy bg-brand-navy text-white" : "border-border"}`}
        >
          Shared only
        </button>
      ) : null}
    </div>
  );

  const clusterList =
    clusters.length > 1 ? (
      <div className="border-t border-border p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Clusters
        </p>
        <ul className="mt-1 space-y-1">
          {clusters.map((cluster, index) => (
            <li key={cluster.id}>
              <PopoverClose asChild>
                <button
                  type="button"
                  aria-label={`Map group: ${cluster.label}`}
                  className="flex w-full items-center gap-2 text-left text-[12px] hover:text-foreground"
                  onClick={() => {
                    const ids = new Set(cluster.nodeIds);
                    mapGroup({
                      id: `cluster:${cluster.id}`,
                      kind: "cluster",
                      label: cluster.label,
                      nodeIds: cluster.nodeIds,
                      edges: visible.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
                    });
                  }}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: CLUSTER_PALETTE[index % CLUSTER_PALETTE.length] }}
                  />
                  <span className="truncate">{cluster.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {cluster.nodeIds.length}
                    {cluster.conflicts
                      ? ` · ${cluster.conflicts} conflict${cluster.conflicts === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </button>
              </PopoverClose>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  /** Witness display names for the files a node is attributed to. */
  const witnessNames = (files: string[]): string[] =>
    files.map((file) => {
      const transcript = transcripts?.find((t) => t.fileName === file);
      return transcript?.witness?.trim() || file.replace(/\.[^.]+$/, "");
    });
  const askContext = (node: DepGraphNode) => ({
    label: node.label,
    kind: node.kind,
    witnesses: witnessNames(visible.files.get(node.id) ?? []),
    neighbors: focusEdges
      .filter((edge) => edge.evidenceStatus === "source_matched")
      .map((edge) => {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        return {
          relation: edge.class === "contradicts" ? "contradicts" : edge.label || "related to",
          other: nodeById.get(otherId)?.label ?? otherId,
          conflict: edge.class === "contradicts",
        };
      }),
    cites: focusEdges
      .filter((edge) => edge.evidenceStatus === "source_matched")
      .map((edge) => `${edge.fileName ?? ""} ${edge.cite}`)
      .filter(Boolean),
  });
  const askFromGraph = (node: DepGraphNode, kind: GraphAskKind) => {
    if (!onAsk) return;
    const question = graphQuestion(kind, askContext(node));
    setAskedHere({ nodeId: node.id, question });
    onAsk(question);
  };
  const inlineAnswer = askedHere && focusNode && askedHere.nodeId === focusNode.id;
  const showDossier =
    selectedEdge || focusNode || insightsOpen || (mapped && mapped.kind !== "insight");

  const dossier = selectedEdge ? (
    <GraphEvidencePanel
      edge={selectedEdge}
      nodes={nodeById}
      onCite={onCite}
      onClose={() => setSelectedEdge(null)}
    />
  ) : insightsOpen ? (
    <GraphMappedInsights
      result={insights}
      selectedId={mapped?.kind === "insight" ? mapped.id : undefined}
      nodes={nodeById}
      onMap={mapInsight}
      onEvidence={setSelectedEdge}
      onClose={() => setInsightsOpen(false)}
    />
  ) : mapped && mapped.kind !== "insight" ? (
    <GraphMappedSelection
      selection={mapped}
      nodes={nodeById}
      onEvidence={setSelectedEdge}
      onBack={() => {
        showAll();
        setInsightsOpen(true);
      }}
    />
  ) : focusNode && focusLaid ? (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-[14px] font-semibold text-foreground">{focusNode.label}</p>
        <p className="text-[11px] text-muted-foreground">
          {KIND_LABEL[focusNode.kind]} · {focusEdges.length} link
          {focusEdges.length === 1 ? "" : "s"}
          {(visible.files.get(focusNode.id) ?? []).length > 1
            ? ` · ${(visible.files.get(focusNode.id) ?? []).length} transcripts`
            : ""}
          {conflictIds.has(focusNode.id) ? " · conflict" : ""}
          {agreeIds.has(focusNode.id) ? " · agreement" : ""}
        </p>
      </div>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Lens
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {LENSES.filter((item) => !item.multiOnly || multi).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={lens === item.id}
              title={item.hint}
              onClick={() => setLens(item.id)}
              className={`border px-2 py-1 text-[11px] ${
                lens === item.id
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10.5px] text-muted-foreground">
          {LENSES.find((item) => item.id === lens)?.hint}
        </p>
      </div>
      {onAsk ? (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-sm"
            disabled={asking}
            onClick={() => askFromGraph(focusNode, LENS_ASK[lens])}
          >
            {asking && inlineAnswer ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : null}
            Ask about this
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm"
            disabled={asking}
            onClick={() => askFromGraph(focusNode, "timeline")}
          >
            Timeline
          </Button>
          {multi ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-sm"
              disabled={asking}
              onClick={() => askFromGraph(focusNode, "witnesses")}
            >
              Compare witnesses
            </Button>
          ) : null}
        </div>
      ) : null}
      {inlineAnswer ? (
        <div className="border border-border bg-surface p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Answer
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {askedHere.question}
          </p>
          <div className="mt-2 text-[12.5px]">
            {asking && !answer ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> Reading the transcript…
              </span>
            ) : answer ? (
              <AnswerMarkdown
                text={answer}
                streaming={!!asking}
                onCite={(ref) => {
                  const n = Number(String(ref).replace(/^S/i, ""));
                  const hit = (hits ?? [])[n - 1];
                  if (hit) onCite(hit.cite || `${hit.page}:1`, hit.fileName);
                }}
              />
            ) : (
              <span className="text-muted-foreground">No answer yet.</span>
            )}
          </div>
        </div>
      ) : null}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Links
        </p>
        <ul className="mt-1 space-y-1.5">
          {focusEdges.map((edge, index) => {
            const otherId = edge.from === focusNode.id ? edge.to : edge.from;
            const other = nodeById.get(otherId);
            return (
              <li
                key={`${edge.from}-${edge.to}-${index}`}
                className="text-[12px] text-muted-foreground"
              >
                <span
                  className={`font-medium ${
                    edge.class === "contradicts"
                      ? "text-destructive"
                      : edge.class === "corroborates"
                        ? "text-emerald-700"
                        : "text-foreground"
                  }`}
                >
                  {edge.class === "contradicts" && edge.title
                    ? `contradicts (${edge.title})`
                    : edge.label}
                </span>{" "}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => selectNode(otherId)}
                >
                  {other?.label ?? otherId}
                </button>
                <button
                  type="button"
                  className="mt-1 flex items-center gap-2 text-xs font-medium text-brand-navy hover:underline"
                  onClick={() => setSelectedEdge(edge)}
                >
                  Review evidence <EvidenceBadge edge={edge} />
                </button>
                {edge.cite && edge.fileName && edge.evidenceStatus === "source_matched" ? (
                  <button
                    type="button"
                    className="ml-1 font-mono text-[11px] text-brand-navy"
                    onClick={() => onCite(edge.cite, edge.fileName)}
                  >
                    {displayCite(edge.cite)}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      {paths.length ? (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Short source-matched paths · up to 6
          </p>
          <ul className="mt-1 space-y-1.5">
            {paths.map((path) => (
              <li
                key={path.nodes.join(">")}
                className="text-[11.5px] leading-relaxed text-muted-foreground"
              >
                <button
                  type="button"
                  className="w-full rounded border border-border p-2 text-left text-foreground hover:border-brand-navy"
                  onClick={() =>
                    mapGroup({
                      id: `path:${path.nodes.join(">")}`,
                      kind: "path",
                      label: path.nodes.map((id) => nodeById.get(id)?.label ?? id).join(" — "),
                      nodeIds: path.nodes,
                      edges: path.edges,
                    })
                  }
                >
                  {serialisePath(path, (id) => nodeById.get(id)?.label ?? id)}
                  <span className="mt-1 flex items-center gap-1 text-xs font-medium text-brand-navy">
                    <LocateFixed className="size-3" />
                    Map path
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  ) : (
    <div className="space-y-2 p-3 text-[12px] leading-relaxed text-muted-foreground">
      <p>
        Click a person, exhibit, or event to open its dossier, then pick a lens: connections, paths
        to shared entities, labelled relationships, or conflicts only. Ask about this answers inside
        this panel.
      </p>
      <p>
        Red links flag potential conflicts; dashed green links flag corroboration. Scroll pans, +/−
        zoom, select a node to frame its neighbourhood, and click a page:line to open the
        transcript.
      </p>
    </div>
  );

  if (!analysis.graph.nodes.length) {
    return (
      <div ref={rootRef} className="text-[13px] text-muted-foreground">
        No connections extracted from this testimony.
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {visible.nodes.length} entities · {visible.edges.length} relationships ·{" "}
          {visible.edges.filter((e) => e.evidenceStatus === "source_matched").length} source matched
        </span>
        <span>AI interpretations · inspect the evidence before use</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2">
        <div
          className="flex rounded border border-border p-0.5"
          role="group"
          aria-label="Relationship display"
        >
          <Button
            variant={mode === "graph" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            <Network className="size-3.5" />
            Graph
          </Button>
          <Button
            variant={mode === "list" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List className="size-3.5" />
            List
          </Button>
        </div>
        <Button
          variant={insightsOpen ? "secondary" : "outline"}
          size="sm"
          className="h-8 gap-1.5 text-xs"
          aria-pressed={insightsOpen}
          onClick={() => {
            setInsightsOpen(!insightsOpen);
            setSelectedEdge(null);
          }}
        >
          <ScanSearch className="size-3.5" />
          Mapped insights <span className="text-muted-foreground">{insights.insights.length}</span>
        </Button>
        {clusterList && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs">
                Groups {clusters.length}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-80 w-72 overflow-y-auto p-0">
              {clusterList}
            </PopoverContent>
          </Popover>
        )}
        <select
          aria-label="Evidence filter"
          className="h-8 rounded border border-border bg-card px-2 text-xs"
          value={view.evidence}
          onChange={(e) =>
            setView((v) => ({ ...v, evidence: e.target.value as GraphViewSettings["evidence"] }))
          }
        >
          <option value="all">All evidence</option>
          <option value="source_matched">Source matched</option>
          <option value="needs_review">Needs review</option>
        </select>
        {transcripts && transcripts.length > 1 ? (
          <select
            aria-label="Transcript filter"
            className="h-8 max-w-48 rounded border border-border bg-card px-2 text-xs"
            value={view.files?.[0] ?? ""}
            onChange={(e) =>
              setView((v) => ({ ...v, files: e.target.value ? [e.target.value] : null }))
            }
          >
            <option value="">All transcripts</option>
            {transcripts.map((t) => (
              <option key={t.fileId} value={t.fileName}>
                {t.witness || t.fileName}
              </option>
            ))}
          </select>
        ) : null}
        {
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 rounded-sm">
                <SlidersHorizontal className="size-3.5" />
                View options
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[22rem]">
              {filters}
            </PopoverContent>
          </Popover>
        }
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Reset graph filters"
          onClick={() => {
            setView({ ...DEFAULT_GRAPH_VIEW });
            setSearch("");
            setActive(null);
            setSelectedEdge(null);
            setMapped(null);
          }}
        >
          <RotateCcw className="size-3.5" />
        </Button>
        <form
          className="relative min-w-[10rem] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            const first = visible.nodes.find((node) => matches.has(node.id));
            if (first) selectNode(first.id);
          }}
        >
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              mode === "list"
                ? "Search relationships or quotes"
                : "Find a person, exhibit, or event"
            }
            aria-label="Search knowledge graph"
            className="h-8 w-full border border-border bg-card pl-7 pr-2 text-[12px] outline-none focus:border-brand-navy/40"
          />
        </form>
        <div className={`ml-auto ${mode === "graph" ? "flex" : "hidden"} items-center gap-1`}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.25)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.25)}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Fit"
            onClick={fit}
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-sm px-2"
            aria-label="1:1"
            onClick={() => move({ x: 0, y: 0, k: 1 })}
          >
            1:1
          </Button>
        </div>
      </div>

      {frameIds?.length ? (
        <div
          className="flex min-h-8 items-center gap-2 rounded border border-border bg-card px-2.5 py-1 text-xs"
          role="status"
          aria-label="Current graph map"
        >
          <LocateFixed className="size-3.5 shrink-0 text-brand-navy" />
          <span
            className="min-w-0 flex-1 truncate font-medium"
            title={selectedEdge?.title || selectedEdge?.label || mapped?.label || focusNode?.label}
          >
            Mapped:{" "}
            {selectedEdge?.title || selectedEdge?.label || mapped?.label || focusNode?.label}
          </span>
          <span className="shrink-0 text-muted-foreground">{frameIds.length} entities</span>
          <button
            type="button"
            className="shrink-0 font-medium text-brand-navy hover:underline"
            onClick={fit}
          >
            Recenter
          </button>
          <button
            type="button"
            className="shrink-0 border-l border-border pl-2 font-medium text-brand-navy hover:underline"
            onClick={showAll}
          >
            Show full graph
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3">
        {mode === "list" ? (
          <GraphRelationshipList
            edges={visible.edges}
            nodes={nodeById}
            search={search}
            onSelect={setSelectedEdge}
          />
        ) : null}
        <div
          ref={viewportRef}
          tabIndex={0}
          className={`relative min-h-[12rem] min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-surface outline-none ${mode === "list" ? "hidden" : ""}`}
          aria-label="Knowledge graph canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          {!visible.nodes.length ? (
            <p className="absolute inset-x-0 top-6 z-30 text-center text-sm text-muted-foreground">
              No entities match these filters. Use Reset graph filters to restore the view.
            </p>
          ) : null}
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})`,
            }}
          >
            <svg width={layout.width} height={layout.height} className="absolute inset-0">
              {visible.edges.map((edge, index) => {
                const a = byId.get(edge.from);
                const b = byId.get(edge.to);
                if (!a || !b) return null;
                const inFocus = mappedEdges
                  ? mappedEdges.has(graphEdgeKey(edge))
                  : hasFocus && linked.has(edge.from) && linked.has(edge.to);
                // The conflicts lens keeps only contradiction and corroboration
                // edges legible around the selected node.
                const lensHidden =
                  lens === "conflicts" && !!active && !mappedEdges && edge.class === "factual";
                const dim = (hasFocus ? !inFocus : false) || lensHidden;
                const on = inFocus && !lensHidden;
                return (
                  <path
                    key={`${edge.from}-${edge.to}-${index}`}
                    d={edgePath(a, b, index % 3)}
                    fill="none"
                    stroke={
                      edge.class === "factual"
                        ? on
                          ? EDGE_HEX.on
                          : EDGE_HEX.factual
                        : EDGE_HEX[edge.class]
                    }
                    strokeWidth={on ? 2.4 : edge.class === "contradicts" ? 1.9 : 1.5}
                    strokeDasharray={
                      edge.evidenceStatus !== "source_matched"
                        ? "3 5"
                        : edge.class === "corroborates"
                          ? "6 4"
                          : undefined
                    }
                    opacity={dim ? 0.08 : 1}
                    markerEnd={`url(#kg-arrow-${edge.class === "factual" ? (on ? "on" : "factual") : edge.class})`}
                  />
                );
              })}
              <defs>
                {(
                  [
                    ["factual", EDGE_HEX.factual],
                    ["on", EDGE_HEX.on],
                    ["contradicts", EDGE_HEX.contradicts],
                    ["corroborates", EDGE_HEX.corroborates],
                  ] as const
                ).map(([id, color]) => (
                  <marker
                    key={id}
                    id={`kg-arrow-${id}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                  </marker>
                ))}
              </defs>
            </svg>
            {visible.edges.map((edge, index) => {
              const a = byId.get(edge.from);
              const b = byId.get(edge.to);
              if (!a || !b) return null;
              const focused = mappedEdges
                ? mappedEdges.has(graphEdgeKey(edge))
                : hasFocus && linked.has(edge.from) && linked.has(edge.to);
              if (hasFocus && !focused) return null;
              if (!shouldShowEdgeLabel(camera.k, view.labels, focused)) return null;
              const mx = (a.x + b.x) / 2;
              const lane = index % 3;
              const lift = (Math.abs(a.y - b.y) < 8 ? 40 : 24) + Math.floor(lane / 2) * 26;
              const my = (a.y + b.y) / 2 + (lane % 2 === 0 ? -lift : lift) / 2;
              return (
                <button
                  key={`label-${edge.from}-${edge.to}-${index}`}
                  type="button"
                  className={`absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded border border-border px-2 py-1 text-[11px] font-medium ${
                    edge.class === "contradicts"
                      ? "bg-destructive text-white"
                      : edge.class === "corroborates"
                        ? "bg-emerald-700 text-white"
                        : "bg-card text-brand-navy ring-1 ring-border"
                  }`}
                  style={{ left: mx, top: my }}
                  onClick={() => setSelectedEdge(edge)}
                  title={`${edge.label} · ${edge.evidenceStatus === "source_matched" ? "Source matched" : "Needs review"}`}
                >
                  {edge.label.slice(0, 28)}
                  {edge.evidenceStatus !== "source_matched" ? " · review" : ""}
                </button>
              );
            })}
            {layout.items.map((item) => {
              const node = nodeById.get(item.id);
              if (!node) return null;
              const degree = visible.degree.get(item.id) ?? 0;
              const files = visible.files.get(item.id) ?? [];
              const selected = active === item.id || (!!mappedEdges && linked.has(item.id));
              const dim = hasFocus
                ? !linked.has(item.id) ||
                  (lens === "conflicts" &&
                    !mappedEdges &&
                    !selected &&
                    !conflictIds.has(item.id) &&
                    !agreeIds.has(item.id))
                : !matches.has(item.id) && search.trim().length > 0;
              const showLabel = shouldShowNodeLabel(
                camera.k,
                degree,
                selected,
                files.length > 1,
                view.labels,
              );
              const width = 168 + Math.min(28, degree * 5);
              const height = camera.k < 0.4 && !selected ? 18 : 56 + Math.min(14, degree * 2);
              const lines = wrapGraphLabel(item.label);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected}
                  data-graph-node={item.id}
                  aria-label={`${item.label}, ${KIND_LABEL[item.kind]}`}
                  className={`absolute z-10 flex flex-col justify-center border border-border border-l-4 bg-card px-2.5 text-left shadow-sm ${
                    selected ? "ring-2 ring-brand-navy" : ""
                  } ${dim ? "opacity-20" : ""}`}
                  style={{
                    left: item.x - width / 2,
                    top: item.y - height / 2,
                    width,
                    height,
                    borderLeftColor: nodeAccent(item.id, item.kind),
                  }}
                  onClick={() => selectNode(active === item.id ? null : item.id)}
                  onDoubleClick={() => selectNode(item.id)}
                  onMouseEnter={() => setHover(item.id)}
                  onMouseLeave={() => setHover((current) => (current === item.id ? null : current))}
                >
                  {showLabel ? (
                    <>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                          {KIND_LABEL[item.kind]}
                        </span>
                        <span className="bg-muted px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {degree}
                        </span>
                      </span>
                      <span className="mt-0.5 text-[12.5px] font-semibold leading-snug text-foreground">
                        {lines.map((line) => (
                          <span key={line} className="block">
                            {line}
                          </span>
                        ))}
                      </span>
                      {multi && files.length > 1 ? (
                        <span className="mt-0.5 text-[10px] text-muted-foreground">
                          {files.length} transcripts
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className={`mx-auto h-2.5 w-2.5 rounded-full ${KIND_DOT[item.kind]}`} />
                  )}
                </button>
              );
            })}
          </div>
          {!fits && !hasFocus ? (
            <button
              type="button"
              aria-label="Minimap"
              className="absolute bottom-2 left-2 overflow-hidden border border-border bg-card/90"
              style={{ width: 140, height: 90 }}
              onClick={fit}
            >
              <svg width={140} height={90} className="block">
                {layout.items.map((item) => (
                  <circle
                    key={item.id}
                    cx={(item.x / layout.width) * 140}
                    cy={(item.y / layout.height) * 90}
                    r={1.8}
                    fill={nodeAccent(item.id, item.kind)}
                  />
                ))}
              </svg>
            </button>
          ) : null}
        </div>

        {dossierAside && showDossier ? (
          <aside
            className={`${rootWidth < 1120 ? "w-[18rem]" : "w-[20rem]"} shrink-0 overflow-y-auto border border-border bg-card`}
          >
            {dossier}
          </aside>
        ) : null}
      </div>

      {!dossierAside && showDossier ? (
        <div className="max-h-[34%] shrink-0 overflow-y-auto border border-border bg-card">
          {dossier}
        </div>
      ) : null}

      <p className="text-[10.5px] text-muted-foreground">
        {conflictCount} potential conflict{conflictCount === 1 ? "" : "s"}
        {" · "}
        {agreeCount} corroboration flag{agreeCount === 1 ? "" : "s"}
        {" · "}
        {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
        {transcripts?.length ? ` · ${transcripts.length} transcripts` : ""}
      </p>
    </div>
  );
}
