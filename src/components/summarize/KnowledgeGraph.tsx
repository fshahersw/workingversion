import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { LocateFixed, Minus, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "@/hooks/use-media-query";
import { nodeFileMap, witnessColumns } from "@/lib/pile/dep-intel";
import { displayCite, type DepAnalysis, type DepGraphNode } from "@/lib/pile/deposition-analysis";
import { CLUSTER_PALETTE, clusterGraph } from "@/lib/pile/graph-cluster";
import { enumeratePaths, rankPaths, serialisePath } from "@/lib/pile/graph-paths";
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
  zoomAt,
  type GraphView,
  type GraphViewSettings,
} from "@/lib/pile/graph-view";
import { fitGraphView, wrapGraphLabel } from "@/lib/pile/knowledge-graph-view";

export type GraphFocus = { id: string; n: number };
export type GraphJumpTab = "ask" | "contradictions" | "exhibits" | "chronology" | "witnesses";

/** Below this many CSS px of component width the dossier docks under the canvas. */
const DOSSIER_SIDE_MIN_WIDTH = 960;

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
  onOpenTab,
  focus: focusReq,
}: {
  analysis: DepAnalysis;
  onCite: (cite: string, fileName?: string) => void;
  multi?: boolean;
  transcripts?: { fileId: string; fileName: string; witness?: string | null }[];
  onAsk?: (q: string, opts?: { fileIds?: string[] }) => void;
  onOpenTab?: (tab: GraphJumpTab) => void;
  focus?: GraphFocus | null;
}) {
  const wideToolbar = useMediaQuery("(min-width: 900px)");
  const rootRef = useRef<HTMLDivElement>(null);
  const rootWidth = useElementWidth(rootRef);
  const dossierAside = rootWidth === 0 || rootWidth >= DOSSIER_SIDE_MIN_WIDTH;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(focusReq?.id ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [camera, setCamera] = useState<GraphView>({ x: 0, y: 0, k: 1 });
  const [view, setView] = useState<GraphViewSettings>(() => loadGraphView());
  const [dragging, setDragging] = useState<{ x: number; y: number; cam: GraphView } | null>(null);
  const fittedKey = useRef("");

  useEffect(() => {
    saveGraphView(view);
  }, [view]);

  useEffect(() => {
    if (!focusReq) return;
    setActive(focusReq.id);
    setView((current) => ({ ...current, minDegree: 0, sharedOnly: false }));
  }, [focusReq]);

  const synthetic = useMemo(
    () => [...conflictEdgesFromAnalysis(analysis), ...corroborationEdgesFromAnalysis(analysis)],
    [analysis],
  );
  // Same attribution the Intelligence tab uses: a node belongs to a witness's
  // transcript when it is that witness or one edge away, so "shared" and the
  // witness layout agree across both views.
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
  const focusId = active ?? hover;
  const linked = useMemo(
    () =>
      hopSet(focusId, visible.edges, view.hops) ?? new Set(visible.nodes.map((node) => node.id)),
    [focusId, visible.edges, visible.nodes, view.hops],
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
    return rankPaths(enumeratePaths(visible.edges, [active], sharedIds)).slice(0, 6);
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

  const fit = useCallback(() => {
    const box = viewportRef.current?.getBoundingClientRect();
    setCamera(
      fitGraphView(
        { width: box?.width ?? 720, height: box?.height ?? 420 },
        { width: layout.width, height: layout.height },
      ),
    );
  }, [layout.height, layout.width]);

  useEffect(() => {
    const key = `${layout.width}x${layout.height}:${visible.nodes.length}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    fit();
  }, [fit, layout.height, layout.width, visible.nodes.length]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const box = viewportRef.current?.getBoundingClientRect();
    if (!box) return;
    const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
    setCamera((current) =>
      zoomAt(current, event.clientX - box.left, event.clientY - box.top, factor),
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, a"))
      return;
    setDragging({ x: event.clientX, y: event.clientY, cam: camera });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setCamera({
      ...dragging.cam,
      x: dragging.cam.x + (event.clientX - dragging.x),
      y: dragging.cam.y + (event.clientY - dragging.y),
    });
  };

  const zoomBy = (factor: number) => {
    const box = viewportRef.current?.getBoundingClientRect();
    setCamera((current) =>
      zoomAt(current, (box?.width ?? 720) / 2, (box?.height ?? 420) / 2, factor),
    );
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
        setCamera({ x: 0, y: 0, k: 1 });
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [fit]);

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
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left text-[12px] hover:text-foreground"
                onClick={() => {
                  setView((current) => ({ ...current, colorBy: "cluster" }));
                  const first = cluster.nodeIds[0];
                  if (first) setActive(first);
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
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const dossier =
    focusNode && focusLaid ? (
      <div className="space-y-3 p-3">
        <div>
          <p className="text-[14px] font-semibold text-foreground">{focusNode.label}</p>
          <p className="text-[11px] text-muted-foreground">
            {KIND_LABEL[focusNode.kind]} · {focusEdges.length} link
            {focusEdges.length === 1 ? "" : "s"}
            {(visible.files.get(focusNode.id) ?? []).length > 1
              ? ` · ${(visible.files.get(focusNode.id) ?? []).length} witnesses`
              : ""}
            {conflictIds.has(focusNode.id) ? " · conflict" : ""}
            {agreeIds.has(focusNode.id) ? " · agreement" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {onAsk ? (
            <Button
              type="button"
              size="sm"
              className="h-7 rounded-sm"
              onClick={() => {
                onOpenTab?.("ask");
                onAsk(`What does the testimony say about ${focusNode.label}?`);
              }}
            >
              Ask about this
            </Button>
          ) : null}
          {onOpenTab ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded-sm"
                onClick={() => onOpenTab("contradictions")}
              >
                Conflicts
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded-sm"
                onClick={() => onOpenTab("exhibits")}
              >
                Exhibits
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded-sm"
                onClick={() => onOpenTab("chronology")}
              >
                Timeline
              </Button>
              {multi ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-sm"
                  onClick={() => onOpenTab("witnesses")}
                >
                  Witnesses
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
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
                    onClick={() => setActive(otherId)}
                  >
                    {other?.label ?? otherId}
                  </button>
                  {edge.cite ? (
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
              Paths
            </p>
            <ul className="mt-1 space-y-1.5">
              {paths.map((path) => (
                <li
                  key={path.nodes.join(">")}
                  className="text-[11.5px] leading-relaxed text-muted-foreground"
                >
                  {serialisePath(path, (id) => nodeById.get(id)?.label ?? id)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    ) : (
      <p className="p-3 text-[12px] leading-relaxed text-muted-foreground">
        Click a person, exhibit, or event to open its dossier. Red edges are contradictions; dashed
        green edges are corroboration. Click a page:line to open the transcript.
      </p>
    );

  if (!layout.items.length) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No connections extracted from this testimony.
      </p>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-1 py-2">
        {wideToolbar ? (
          filters
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 rounded-sm">
                Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[22rem]">
              {filters}
            </PopoverContent>
          </Popover>
        )}
        <form
          className="relative min-w-[10rem] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            const first = visible.nodes.find((node) => matches.has(node.id));
            if (first) setActive(first.id);
          }}
        >
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a node"
            className="h-8 w-full border border-border bg-card pl-7 pr-2 text-[12px] outline-none focus:border-brand-navy/40"
          />
        </form>
        <div className="ml-auto flex items-center gap-1">
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
            onClick={() => setCamera({ x: 0, y: 0, k: 1 })}
          >
            1:1
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div
          ref={viewportRef}
          tabIndex={0}
          className="relative min-h-[28rem] min-w-0 flex-1 overflow-hidden border border-border bg-surface outline-none"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
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
                const dim = focusId ? !linked.has(edge.from) || !linked.has(edge.to) : false;
                const on = focusId ? linked.has(edge.from) && linked.has(edge.to) : false;
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
                    strokeWidth={on ? 2.4 : 1.5}
                    strokeDasharray={edge.class === "corroborates" ? "6 4" : undefined}
                    opacity={dim ? 0.08 : 1}
                    markerEnd="url(#kg-arrow)"
                  />
                );
              })}
              <defs>
                <marker
                  id="kg-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
                </marker>
              </defs>
            </svg>
            {visible.edges.map((edge, index) => {
              const a = byId.get(edge.from);
              const b = byId.get(edge.to);
              if (!a || !b) return null;
              const focused = !!(focusId && linked.has(edge.from) && linked.has(edge.to));
              if (!shouldShowEdgeLabel(camera.k, view.labels, focused)) return null;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2 - 18;
              return (
                <button
                  key={`label-${edge.from}-${edge.to}-${index}`}
                  type="button"
                  className={`absolute z-20 -translate-x-1/2 -translate-y-full px-1.5 py-0.5 font-mono text-[10px] ${
                    edge.class === "contradicts"
                      ? "bg-destructive text-white"
                      : edge.class === "corroborates"
                        ? "bg-emerald-700 text-white"
                        : "bg-card text-brand-navy ring-1 ring-border"
                  }`}
                  style={{ left: mx, top: my }}
                  onClick={() => edge.cite && onCite(edge.cite)}
                >
                  {edge.cite ? displayCite(edge.cite) : edge.label.slice(0, 22)}
                </button>
              );
            })}
            {layout.items.map((item) => {
              const node = nodeById.get(item.id);
              if (!node) return null;
              const degree = visible.degree.get(item.id) ?? 0;
              const files = visible.files.get(item.id) ?? [];
              const selected = active === item.id;
              const dim = focusId
                ? !linked.has(item.id)
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
                  className={`absolute z-10 flex flex-col justify-center border border-border border-l-4 bg-card px-2.5 text-left shadow-sm ${
                    selected ? "ring-2 ring-brand-navy" : ""
                  } ${conflictIds.has(item.id) ? "ring-1 ring-destructive/70" : ""} ${
                    dim ? "opacity-20" : ""
                  }`}
                  style={{
                    left: item.x - width / 2,
                    top: item.y - height / 2,
                    width,
                    height,
                    borderLeftColor: nodeAccent(item.id, item.kind),
                  }}
                  onClick={() => setActive((current) => (current === item.id ? null : item.id))}
                  onDoubleClick={() => {
                    setActive(item.id);
                    const box = viewportRef.current?.getBoundingClientRect();
                    const neighbors = layout.items.filter(
                      (other) => linked.has(other.id) || other.id === item.id,
                    );
                    const minX = Math.min(...neighbors.map((other) => other.x)) - 80;
                    const minY = Math.min(...neighbors.map((other) => other.y)) - 60;
                    const maxX = Math.max(...neighbors.map((other) => other.x)) + 80;
                    const maxY = Math.max(...neighbors.map((other) => other.y)) + 60;
                    setCamera(
                      fitGraphView(
                        { width: box?.width ?? 720, height: box?.height ?? 420 },
                        { width: maxX - minX, height: maxY - minY },
                        24,
                      ),
                    );
                  }}
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
                          {files.length} witnesses
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
          {!fits ? (
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

        {dossierAside ? (
          <aside className="w-[20rem] shrink-0 overflow-y-auto border border-border bg-card">
            {dossier}
            {clusterList}
          </aside>
        ) : null}
      </div>

      {!dossierAside && (focusNode || clusterList) ? (
        <div className="max-h-[15rem] shrink-0 overflow-y-auto border border-border bg-card">
          {dossier}
          {clusterList}
        </div>
      ) : null}

      <p className="text-[10.5px] text-muted-foreground">
        {conflictCount} conflict{conflictCount === 1 ? "" : "s"}
        {" · "}
        {agreeCount} agreement{agreeCount === 1 ? "" : "s"}
        {" · "}
        {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
        {transcripts?.length ? ` · ${transcripts.length} transcripts` : ""}
      </p>
    </div>
  );
}
