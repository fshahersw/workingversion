import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Node, NodeProps, NodeChange, EdgeChange } from "@xyflow/react";
import { catalog, definition, groups } from "./catalog";
import { canConnect } from "./graph";
import { Badge, Icon, IconButton, Tile } from "./ui";
import type { StepKind, Workflow, WorkflowStep, WorkflowRun } from "./types";
import "@xyflow/react/dist/style.css";

type CanvasData = WorkflowStep["data"] & {
  issue?: boolean;
  status?: string;
  onAdd?: (id: string) => void;
};
type CanvasNode = Node<CanvasData, "step">;
const statusIcons: Record<string, string> = {
  completed: "CheckCircle2",
  waiting: "Clock3",
  running: "Loader2",
  failed: "CircleAlert",
  skipped: "Minus",
};
function StepNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const d = definition(data.kind);
  return (
    <div
      className={`swf-node ${selected ? "is-selected" : ""} ${data.issue ? "has-issue" : ""} ${data.status ? `is-${data.status}` : ""}`}
      data-testid={`step-${id}`}
    >
      {data.kind !== "trigger" && (
        <Handle type="target" position={Position.Top} aria-label={`Input to ${data.label}`} />
      )}
      <div className="swf-node-main">
        <Tile icon={d.icon} tone={d.tone} small />
        <div className="swf-node-copy">
          <strong>{data.label}</strong>
          <span>
            {data.kind === "condition"
              ? `${data.config.left || "Choose a field"} ${data.config.operator?.replaceAll("_", " ") || ""}`
              : data.kind === "review"
                ? data.config.reviewer || "Choose a reviewer"
                : data.kind === "prompt" || data.kind === "agent"
                  ? data.config.model === "bedrock"
                    ? "Bedrock · connected model"
                    : "Bedrock · approved model"
                  : d.description}
          </span>
        </div>
        {data.status && statusIcons[data.status] ? (
          <Icon
            name={statusIcons[data.status]}
            className={data.status === "running" ? "swf-spin" : ""}
            size={15}
          />
        ) : (
          <Icon name="GripVertical" size={14} className="swf-node-grip" />
        )}
      </div>
      <div className="swf-node-output">
        <span>Output</span>
        <code>{data.output || "unnamed"}</code>
        {data.issue && <Icon name="CircleAlert" size={12} />}
      </div>
      {data.kind === "condition" ? (
        <>
          <span className="swf-handle-label swf-handle-true">True</span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: "25%" }}
            aria-label={`True branch of ${data.label}`}
          />
          <span className="swf-handle-label swf-handle-false">False</span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: "75%" }}
            aria-label={`False branch of ${data.label}`}
          />
        </>
      ) : (
        data.kind !== "response" && (
          <Handle
            type="source"
            position={Position.Bottom}
            aria-label={`Output from ${data.label}`}
          />
        )
      )}
    </div>
  );
}
const nodeTypes = { step: StepNode };

export type CanvasProps = {
  flow: Workflow;
  selectedId?: string;
  issueIds: Set<string>;
  run?: WorkflowRun;
  onSelect: (id?: string) => void;
  onMove: (nodes: WorkflowStep[], checkpoint?: boolean) => void;
  onConnect: (connection: Connection) => void;
  onDeleteEdges: (ids: string[]) => void;
  onAdd: (kind: StepKind, position?: { x: number; y: number }, insert?: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTidy: () => void;
  canUndo: boolean;
  canRedo: boolean;
};
function CanvasInner(props: CanvasProps) {
  const { flow, selectedId, onMove } = props;
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [query, setQuery] = useState("");
  const [palette, setPalette] = useState(() => window.innerWidth > 1000);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  useEffect(() => {
    const media = matchMedia("(min-width: 1001px)");
    const update = () => setPalette(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const nodes = useMemo<CanvasNode[]>(
    () =>
      flow.nodes.map((n) => ({
        ...n,
        ...sizes[n.id],
        measured: sizes[n.id],
        selected: n.id === selectedId,
        data: {
          ...n.data,
          issue: props.issueIds.has(n.id),
          status: props.run?.results[n.id]?.status,
        },
      })),
    [flow.nodes, selectedId, props.issueIds, props.run, sizes],
  );
  const edges = useMemo(
    () =>
      flow.edges.map((e) => ({
        ...e,
        type: "smoothstep",
        animated:
          props.run?.status === "running" && props.run.results[e.source]?.status === "completed",
        style: { stroke: "var(--swf-border-strong)", strokeWidth: 1.4 },
        labelStyle: { fill: "var(--swf-muted)", fontSize: 10, fontWeight: 500 },
        labelBgStyle: { fill: "var(--swf-soft)" },
        labelBgPadding: [5, 4] as [number, number],
        labelBgBorderRadius: 4,
      })),
    [flow.edges, props.run],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      for (const change of changes)
        if (change.type === "dimensions" && change.dimensions) {
          const size = change.dimensions;
          setSizes((old) =>
            old[change.id]?.width === size.width && old[change.id]?.height === size.height
              ? old
              : { ...old, [change.id]: size },
          );
        }
      const positions = changes.filter((c) => c.type === "position");
      if (positions.length)
        onMove(
          applyNodeChanges(positions, nodes).map(({ id, type, position, data }) => ({
            id,
            type: type as "step",
            position,
            data: {
              kind: data.kind,
              label: data.label,
              output: data.output,
              config: data.config,
            },
          })),
          false,
        );
    },
    [nodes, onMove],
  );
  const onEdgesChange = (changes: EdgeChange[]) => {
    const ids = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (ids.length) props.onDeleteEdges(ids);
  };
  const addAtCenter = (kind: StepKind) => {
    const bounds = document.querySelector(".swf-canvas")?.getBoundingClientRect();
    props.onAdd(
      kind,
      bounds
        ? screenToFlowPosition({
            x: bounds.left + bounds.width / 2 - 120,
            y: bounds.top + bounds.height / 2 - 45,
          })
        : undefined,
      true,
    );
    if (window.innerWidth <= 1000) setPalette(false);
  };
  return (
    <div className="swf-canvas-area">
      {palette && (
        <aside className="swf-palette" aria-label="Step library">
          <div className="swf-panel-heading">
            <strong>Step library</strong>
            <IconButton
              icon="PanelLeftClose"
              label="Hide step library"
              onClick={() => setPalette(false)}
            />
          </div>
          <div className="swf-palette-search">
            <Icon name="Search" size={15} />
            <input
              aria-label="Search steps"
              placeholder="Search steps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>/</kbd>
          </div>
          <p className="swf-palette-hint">
            Drag to place freely. Click to insert by the selected step.
          </p>
          <div className="swf-palette-list">
            {groups.map((group) => {
              const items = catalog.filter(
                (d) =>
                  d.group === group &&
                  `${d.label} ${d.description}`.toLowerCase().includes(query.toLowerCase()) &&
                  d.kind !== "trigger",
              );
              return items.length ? (
                <section key={group}>
                  <h3>{group}</h3>
                  {items.map((d) => (
                    <button
                      className="swf-palette-item"
                      key={d.kind}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/secretwise-step", d.kind);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => addAtCenter(d.kind)}
                      title={d.description}
                    >
                      <Tile icon={d.icon} tone={d.tone} small />
                      <span>{d.label}</span>
                      <Icon name="GripVertical" size={13} />
                    </button>
                  ))}
                </section>
              ) : null;
            })}
            {!catalog.some((d) =>
              `${d.label} ${d.description}`.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="swf-empty-inline">No matching steps.</p>}
          </div>
          <div className="swf-palette-footer">
            <Icon name="Plug2" />
            <span>Ready for your platform tools</span>
          </div>
        </aside>
      )}
      <div
        className="swf-canvas"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const kind = e.dataTransfer.getData("application/secretwise-step") as StepKind;
          if (catalog.some((d) => d.kind === kind && kind !== "trigger"))
            props.onAdd(kind, screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 38 }));
        }}
      >
        <div className="swf-canvas-toolbar">
          <IconButton
            icon={palette ? "PanelLeftClose" : "PanelLeftOpen"}
            label={palette ? "Hide step library" : "Show step library"}
            onClick={() => setPalette(!palette)}
          />
          <IconButton icon="Undo2" label="Undo" disabled={!props.canUndo} onClick={props.onUndo} />
          <IconButton icon="Redo2" label="Redo" disabled={!props.canRedo} onClick={props.onRedo} />
          <span className="swf-toolbar-divider" />
          <button
            className="swf-text-button"
            onClick={() => {
              props.onTidy();
              setTimeout(() => fitView({ padding: 0.08, duration: 300 }), 80);
            }}
          >
            <Icon name="LayoutGrid" size={14} />
            Tidy up
          </button>
          <IconButton
            icon="Maximize2"
            label="Fit workflow to screen"
            onClick={() => fitView({ padding: 0.08, duration: 300 })}
          />
        </div>
        <ReactFlow<CanvasNode>
          key={flow.id}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => props.onSelect(n.id)}
          onPaneClick={() => props.onSelect(undefined)}
          onConnect={props.onConnect}
          isValidConnection={(c) =>
            canConnect(c.source, c.target, flow.nodes, flow.edges, c.sourceHandle)
          }
          onNodeDragStart={() => props.onMove(flow.nodes, true)}
          onNodeDragStop={() => {}}
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={1.75}
          snapToGrid
          snapGrid={[10, 10]}
          deleteKeyCode={null}
          selectionOnDrag={false}
          nodesFocusable
          edgesFocusable
          connectionRadius={24}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--swf-line)" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            style={{ width: 116, height: 80 }}
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => (n.selected ? "var(--swf-primary)" : "var(--swf-line)")}
            maskColor="color-mix(in oklab, var(--swf-soft) 72%, transparent)"
          />
        </ReactFlow>
        <div className="swf-canvas-caption">
          <Badge>{flow.nodes.length} steps</Badge>
          <span>Drag to move · connect the circles · scroll to zoom</span>
        </div>
      </div>
    </div>
  );
}
export function WorkflowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
