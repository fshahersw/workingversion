import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStep } from "./catalog";
import { downloadBlob } from "./files";
import { canConnect, exportWorkflow, importWorkflow, tidyLayout, validateWorkflow } from "./graph";
import { Library, RunHistory } from "./Library";
import { AppStudio, AppFormEditor } from "./AppStudio";
import { appTemplates, createAppWorkflow } from "./app-templates";
import { RunPanel } from "./RunPanel";
import { blankWorkflow, fromTemplate } from "./seeds";
import { StepInspector } from "./StepInspector";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { NewWorkflowDialog, ScheduleDialog, ShareDialog } from "./WorkflowDialogs";
import { Badge, Button, Icon, IconButton, Modal, Notice } from "./ui";
import { workflowClient, type Capabilities } from "./client";
import type {
  RunInputs,
  Schedule,
  Sharing,
  StepKind,
  Workflow,
  WorkflowRun,
  WorkflowStep,
} from "./types";
import "./styles.css";
import "./apps.css";
type Snapshot = { nodes: WorkflowStep[]; edges: Workflow["edges"] };
const graphOf = (f: Workflow): Snapshot => structuredClone({ nodes: f.nodes, edges: f.edges });
export function WorkflowsPage({
  currentUser,
  initialWorkflowId,
  onNavigate,
}: {
  currentUser: { name: string; initials: string };
  initialWorkflowId?: string;
  onNavigate: (id?: string) => void;
}) {
  const embedded = true,
    workspaceName = "Seeger Weiss";
  const [flows, setFlows] = useState<Workflow[]>([]),
    [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>(),
    [storageReady, setStorageReady] = useState(false);
  const [activeId, setActiveId] = useState(initialWorkflowId),
    [selectedId, setSelectedId] = useState<string>();
  const [builderTab, setBuilderTab] = useState("builder"),
    [dialog, setDialog] = useState<"new" | "share" | "schedule" | "publish" | "about" | null>(null),
    [deleteId, setDeleteId] = useState<string>();
  const [runPanel, setRunPanel] = useState<{ workflowId: string; runId?: string }>(),
    [watchedRun, setWatchedRun] = useState<string>();
  const [toast, setToast] = useState(""),
    [storageError, setStorageError] = useState(""),
    [saving, setSaving] = useState(false),
    [publishing, setPublishing] = useState(false),
    [publishError, setPublishError] = useState("");
  const [, refreshHistory] = useState(0);
  const editVersions = useRef<Record<string, number>>({}),
    pendingSaves = useRef(new Map<string, Promise<Workflow>>());
  const unsaved = useRef(new Set<string>()),
    undo = useRef<Record<string, Snapshot[]>>({}),
    redo = useRef<Record<string, Snapshot[]>>({});
  const flowsRef = useRef(flows);
  flowsRef.current = flows;
  const flow = flows.find((f) => f.id === activeId),
    selected = flow?.nodes.find((n) => n.id === selectedId);
  const issues = useMemo(() => (flow ? validateWorkflow(flow) : []), [flow]),
    errorCount = issues.filter((i) => i.severity === "error").length;
  const issueIds = useMemo(
    () => new Set(issues.filter((i) => i.severity === "error" && i.nodeId).map((i) => i.nodeId!)),
    [issues],
  );
  const currentRun = runs.find((r) => r.id === runPanel?.runId),
    activeRun = runs.find(
      (r) => r.workflowId === activeId && ["running", "waiting"].includes(r.status),
    );
  const showError = (error: unknown) =>
    setStorageError(error instanceof Error ? error.message : "Workflow request failed.");
  const upsertRun = useCallback(
    (run: WorkflowRun) =>
      setRuns((old) =>
        old.some((r) => r.id === run.id)
          ? old.map((r) => (r.id === run.id ? run : r))
          : [run, ...old],
      ),
    [],
  );
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const c = await workflowClient.capabilities();
        if (!live) return;
        setCapabilities(c);
        if (c.enabled) {
          const [f, r] = await Promise.all([workflowClient.list(), workflowClient.runs()]);
          if (live) {
            setFlows(f);
            setRuns(r);
          }
        }
        if (live) setStorageReady(true);
      } catch (e) {
        if (live) showError(e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    setActiveId(initialWorkflowId);
  }, [initialWorkflowId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (unsaved.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  useEffect(() => {
    let live = true;
    let busy = false;
    const pending = new Set([watchedRun, runPanel?.runId].filter((id): id is string => !!id));
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const id of pending) {
          const run = await workflowClient.run(id);
          if (live) upsertRun(run);
          if (!["running", "waiting"].includes(run.status)) pending.delete(id);
        }
      } catch (e) {
        if (live) showError(e);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [watchedRun, runPanel?.runId, upsertRun]);
  const open = useCallback(
    (id?: string) => {
      setActiveId(id);
      setSelectedId(undefined);
      setBuilderTab("builder");
      onNavigate(id);
    },
    [onNavigate],
  );
  const persist = async (f: Workflow) => {
    if (!unsaved.current.has(f.id) && f.revision) return f;
    const existing = pendingSaves.current.get(f.id);
    if (existing) return existing;
    const generation = editVersions.current[f.id] || 0;
    setSaving(true);
    const task = (async () => {
      try {
        const saved = await workflowClient.save(f);
        const changed = (editVersions.current[f.id] || 0) !== generation;
        if (!changed) unsaved.current.delete(f.id);
        setFlows((old) =>
          old.map((v) =>
            v.id === f.id
              ? changed
                ? { ...v, revision: saved.revision }
                : { ...saved, access: v.access || "owner" }
              : v,
          ),
        );
        setStorageError("");
        return { ...saved, access: f.access };
      } finally {
        pendingSaves.current.delete(f.id);
        setSaving(false);
      }
    })();
    pendingSaves.current.set(f.id, task);
    return task;
  };
  const addFlow = useCallback(
    async (f: Workflow) => {
      setSaving(true);
      try {
        f.createdBy = currentUser.name;
        const saved = await workflowClient.save(f);
        setFlows((old) => [{ ...saved, access: "owner" }, ...old]);
        open(saved.id);
        setDialog(null);
      } catch (e) {
        showError(e);
      } finally {
        setSaving(false);
      }
    },
    [currentUser.name, open],
  );
  const checkpoint = useCallback((f: Workflow) => {
    undo.current[f.id] = [...(undo.current[f.id] || []), graphOf(f)].slice(-50);
    redo.current[f.id] = [];
    refreshHistory((x) => x + 1);
  }, []);
  const updateFlow = useCallback(
    (id: string, transform: (f: Workflow) => Workflow, graphChange = false, remember = false) => {
      const old = flowsRef.current.find((f) => f.id === id);
      if (!old) return;
      if (!["owner", "edit"].includes(old.access || "owner")) {
        setToast("This workflow is read-only. Duplicate it to make your own draft.");
        return;
      }
      editVersions.current[id] = (editVersions.current[id] || 0) + 1;
      if (remember) checkpoint(old);
      unsaved.current.add(id);
      setFlows((current) =>
        current.map((f) =>
          f.id === id
            ? {
                ...transform(f),
                updatedAt: new Date().toISOString(),
                ...(graphChange ? { dirty: true } : {}),
              }
            : f,
        ),
      );
    },
    [checkpoint],
  );
  const graphChange = (snapshot: Snapshot, remember = true) => {
    if (flow) updateFlow(flow.id, (f) => ({ ...f, ...snapshot }), true, remember);
  };
  const travel = (direction: "undo" | "redo") => {
    if (!flow) return;
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
    const snapshot = from.current[flow.id]?.pop();
    if (!snapshot) return;
    to.current[flow.id] = [...(to.current[flow.id] || []), graphOf(flow)];
    graphChange(snapshot, false);
  };
  const addStep = (kind: StepKind, position?: { x: number; y: number }, insert = false) => {
    if (!flow) return;
    if (flow.nodes.length >= 80) {
      setToast("This workflow has reached the 80-step limit.");
      return;
    }
    let sequence = flow.nodes.length + 1;
    while (flow.nodes.some((n) => n.data.output === `${kind}_${sequence}`)) sequence++;
    const step = makeStep(
      kind,
      sequence,
      position || {
        x: 260,
        y: Math.max(...flow.nodes.map((n) => n.position.y)) + 150,
      },
    );
    if (
      insert &&
      selected &&
      selected.data.kind !== "condition" &&
      kind !== "condition" &&
      kind !== "response"
    ) {
      const beforeEnd = selected.data.kind === "response";
      step.position = {
        x: selected.position.x,
        y: selected.position.y + (beforeEnd ? 0 : 130),
      };
      const nodes = flow.nodes.map((n) =>
        n.position.y >= step.position.y
          ? { ...n, position: { ...n.position, y: n.position.y + 130 } }
          : n,
      );
      const edges = flow.edges.map((e) =>
        beforeEnd && e.target === selected.id
          ? { ...e, target: step.id }
          : !beforeEnd && e.source === selected.id
            ? { ...e, source: step.id }
            : e,
      );
      edges.push({
        id: crypto.randomUUID(),
        source: beforeEnd ? step.id : selected.id,
        target: beforeEnd ? selected.id : step.id,
      });
      graphChange({ nodes: [...nodes, step], edges });
      setSelectedId(step.id);
      setToast(
        `${step.data.label} inserted ${beforeEnd ? "before" : "after"} ${selected.data.label}.`,
      );
      return;
    }
    graphChange({ nodes: [...flow.nodes, step], edges: flow.edges });
    setSelectedId(step.id);
    setToast(`${step.data.label} added. Connect it to the workflow.`);
  };
  const connect = (source: string, target: string, handle?: string | null) => {
    if (!flow || !canConnect(source, target, flow.nodes, flow.edges, handle)) {
      setToast("That connection would create an invalid path.");
      return;
    }
    graphChange({
      nodes: flow.nodes,
      edges: [
        ...flow.edges,
        {
          id: crypto.randomUUID(),
          source,
          target,
          sourceHandle: handle,
          ...(handle ? { label: handle === "true" ? "True" : "False" } : {}),
        },
      ],
    });
  };
  const duplicateFlow = (id: string) => {
    const source = flows.find((f) => f.id === id);
    if (source) {
      const copy = importWorkflow(exportWorkflow(source));
      copy.name += " (copy)";
      copy.createdBy = currentUser.name;
      addFlow(copy);
      setToast("Workflow duplicated as a private draft.");
    }
  };
  const exportFlow = (f: Workflow) => {
    downloadBlob(
      `${f.name.replace(/[^\w -]/g, "").trim() || "workflow"}.json`,
      new Blob([exportWorkflow(f)], { type: "application/json" }),
    );
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > 500000) throw new Error("Workflow files must be smaller than 500 KB.");
      const imported = importWorkflow(await file.text());
      addFlow(imported);
      setToast("Workflow imported as a private draft.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "This workflow could not be imported.");
    }
  };

  const showRun = async (workflowId: string, id: string) => {
    try {
      upsertRun(await workflowClient.run(id));
      setRunPanel({ workflowId, runId: id });
    } catch (e) {
      showError(e);
    }
  };
  const startRun = async (
    inputs: RunInputs,
    f: Workflow,
    _source: WorkflowRun["source"] = "manual",
    published = false,
    showPanel = true,
  ) => {
    if (f.access === "view")
      throw new Error("This workflow grants view access. Request run access from its owner.");
    const saved = await persist(f);
    if (unsaved.current.has(f.id))
      throw new Error("New edits arrived while saving. Save the latest draft before running it.");
    const usePublished = published || ["run", "view"].includes(saved.access || f.access || "");
    const run = await workflowClient.start(saved, inputs, usePublished, crypto.randomUUID());
    upsertRun(run);
    setWatchedRun(run.id);
    if (showPanel) setRunPanel({ workflowId: f.id, runId: run.id });
    return run.id;
  };
  const cancelRun = async () => {
    if (!currentRun) return;
    try {
      upsertRun(await workflowClient.cancel(currentRun.id));
    } catch (e) {
      showError(e);
    }
  };
  const approve = async (approved: boolean, notes: string) => {
    if (!currentRun) return;
    try {
      upsertRun(await workflowClient.review(currentRun.id, approved, notes));
      setWatchedRun(currentRun.id);
    } catch (e) {
      showError(e);
    }
  };
  const replaceFlow = (f: Workflow, generation: number) => {
    const changed = (editVersions.current[f.id] || 0) !== generation;
    if (!changed) unsaved.current.delete(f.id);
    setFlows((old) =>
      old.map((v) =>
        v.id !== f.id
          ? v
          : changed
            ? {
                ...v,
                revision: f.revision,
                version: f.version,
                publishedAt: f.publishedAt,
                publishedGraph: f.publishedGraph,
                publishedApp: f.publishedApp,
                sharing: f.sharing,
                schedule: f.schedule,
                dirty: true,
              }
            : { ...f, access: v.access },
      ),
    );
  };
  const publish = async () => {
    if (!flow || errorCount) return;
    setPublishing(true);
    setPublishError("");
    const generation = editVersions.current[flow.id] || 0;
    try {
      const saved = await persist(flow);
      replaceFlow(await workflowClient.change(saved, "publish"), generation);
      setDialog(null);
      setToast("Published version saved.");
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  };
  const saveSharing = async (sharing: Sharing) => {
    if (!flow) return;
    const generation = editVersions.current[flow.id] || 0;
    const saved = await persist(flow);
    replaceFlow(await workflowClient.change(saved, "share", sharing), generation);
    setToast("Team access updated.");
  };
  const saveSchedule = async (schedule: Schedule) => {
    if (!flow) return;
    const generation = editVersions.current[flow.id] || 0;
    const saved = await persist(flow);
    replaceFlow(await workflowClient.change(saved, "schedule", schedule), generation);
    setToast("Schedule saved.");
  };
  const copyLink = async () => {
    if (flow)
      await navigator.clipboard.writeText(
        location.origin + "/workflows?workflow=" + encodeURIComponent(flow.id),
      );
  };
  const removeWorkflow = async (id: string) => {
    const f = flows.find((f) => f.id === id);
    if (!f) return;
    try {
      await workflowClient.change(f, "delete");
      unsaved.current.delete(id);
      setFlows((old) => old.filter((f) => f.id !== id));
      if (activeId === id) open();
      setDeleteId(undefined);
      setToast("Workflow archived.");
    } catch (e) {
      showError(e);
    }
  };
  if (!storageReady || !capabilities?.enabled)
    return (
      <div className="swf-root swf-app swf-embedded">
        <div className="swf-empty">
          <Icon name="WorkflowIcon" size={28} />
          <h2>
            {storageError
              ? "Workflows could not load"
              : !storageReady
                ? "Loading Workflows"
                : "Workflows is not enabled here"}
          </h2>
          <p>
            {storageError ||
              (!storageReady
                ? "Connecting to your authenticated workspace…"
                : "Your platform administrator must enable workflow storage and the server worker before this page can be used.")}
          </p>
          <Button onClick={() => location.reload()}>Retry</Button>
        </div>
      </div>
    );
  return (
    <div className={`swf-root swf-app${embedded ? " swf-embedded" : ""}`}>
      {!embedded && (
        <header className="swf-app-header">
          <button
            className="swf-brand"
            onClick={() => open()}
            aria-label={`${workspaceName} workflows home`}
          >
            <Icon name="WorkflowIcon" size={18} />
            <strong>Workflows</strong>
            <span className="swf-brand-separator" />
            <span>{workspaceName}</span>
          </button>
          <div className="swf-header-right">
            <button className="swf-mode-indicator" onClick={() => setDialog("about")}>
              <i className="swf-dot swf-green" />
              {capabilities?.queue ? "Tools configured" : "Local workspace"}
              <Icon name="Info" size={13} />
            </button>
            <span className="swf-avatar" title={currentUser.name}>
              {currentUser.initials}
            </span>
          </div>
        </header>
      )}
      {storageError && (
        <div className="swf-storage-error" role="alert">
          <Icon name="CircleAlert" />
          {storageError}
          {flow && <Button onClick={() => exportFlow(flow)}>Export workflow</Button>}
        </div>
      )}
      {!flow ? (
        <Library
          flows={flows}
          runs={runs}
          onOpen={(id) => {
            open(id);
            const f = flows.find((item) => item.id === id);
            setSelectedId(
              window.innerWidth > 760
                ? f?.nodes.find((n) => n.data.kind === "extract")?.id
                : undefined,
            );
          }}
          onNew={() => setDialog("new")}
          onTemplate={(id) =>
            addFlow(
              appTemplates.some((t) => t.id === id)
                ? createAppWorkflow(id, true)
                : fromTemplate(id),
            )
          }
          onApp={async (id) => {
            await addFlow(createAppWorkflow(id));
            setBuilderTab("app");
          }}
          onOpenApp={(id) => {
            open(id);
            setBuilderTab("app");
          }}
          onAbout={() => setDialog("about")}
          onImport={(file) => void importFile(file)}
          onDuplicate={duplicateFlow}
          onDelete={setDeleteId}
          onRun={(f) =>
            f.app ? (open(f.id), setBuilderTab("app")) : setRunPanel({ workflowId: f.id })
          }
          onViewRun={(id) => {
            const r = runs.find((run) => run.id === id);
            if (r) void showRun(r.workflowId, id);
          }}
        />
      ) : (
        <>
          <div className="swf-builder-heading">
            <div className="swf-builder-title">
              <IconButton icon="ArrowLeft" label="Back to all workflows" onClick={() => open()} />
              <div>
                <input
                  aria-label="Workflow name"
                  value={flow.name}
                  maxLength={100}
                  readOnly={!["owner", "edit"].includes(flow.access || "owner")}
                  onChange={(e) =>
                    updateFlow(flow.id, (f) => ({ ...f, name: e.target.value }), true)
                  }
                />
                <div className="swf-title-meta">
                  <Badge tone={flow.publishedAt && !flow.dirty ? "green" : "slate"}>
                    {flow.publishedAt
                      ? flow.dirty
                        ? `Draft · v${flow.version} published`
                        : `Published · v${flow.version}`
                      : "Draft"}
                  </Badge>
                  <span>
                    <Icon name={saving ? "Loader2" : "Check"} size={12} />
                    {storageError
                      ? "Not saved"
                      : saving
                        ? "Saving…"
                        : unsaved.current.has(flow.id)
                          ? "Unsaved changes"
                          : "Saved to workspace"}
                  </span>
                </div>
              </div>
            </div>
            <div className="swf-builder-actions">
              <Button
                icon="Save"
                disabled={
                  saving ||
                  !unsaved.current.has(flow.id) ||
                  !["owner", "edit"].includes(flow.access || "owner")
                }
                onClick={() => void persist(flow).catch(showError)}
              >
                Save draft
              </Button>
              <IconButton
                icon="Info"
                label="Workspace information"
                onClick={() => setDialog("about")}
              />
              <Button
                variant="ghost"
                icon="Users"
                disabled={flow.access !== "owner"}
                onClick={() => setDialog("share")}
              >
                Share
              </Button>
              <Button
                variant="ghost"
                icon="CalendarClock"
                className={flow.schedule.enabled ? "swf-active-schedule" : ""}
                disabled={flow.access !== "owner"}
                onClick={() => setDialog("schedule")}
              >
                Schedule
              </Button>
              <span className="swf-toolbar-divider" />
              <Button
                icon="Play"
                disabled={flow.access === "view" || !capabilities?.queue}
                onClick={() => setRunPanel({ workflowId: flow.id })}
              >
                {flow.access === "run" ? "Run published" : "Test run"}
              </Button>
              <Button
                variant="primary"
                onClick={() => setDialog("publish")}
                disabled={flow.access !== "owner" || (!!flow.publishedAt && !flow.dirty)}
              >
                Publish
              </Button>
            </div>
          </div>
          <div className="swf-builder-subbar">
            <div className="swf-builder-tabs">
              <button
                className={builderTab === "app" ? "active" : ""}
                onClick={() => setBuilderTab("app")}
              >
                <Icon name="LayoutGrid" size={14} />
                Mini app
              </button>
              <button
                className={builderTab === "builder" ? "active" : ""}
                onClick={() => setBuilderTab("builder")}
              >
                <Icon name="WorkflowIcon" size={14} />
                Builder
              </button>
              <button
                className={builderTab === "form" ? "active" : ""}
                onClick={() => setBuilderTab("form")}
              >
                <Icon name="Settings2" size={14} />
                App form
              </button>
              <button
                className={builderTab === "history" ? "active" : ""}
                onClick={() => setBuilderTab("history")}
              >
                <Icon name="History" size={14} />
                Run history <span>{runs.filter((r) => r.workflowId === flow.id).length}</span>
              </button>
            </div>
            <div className="swf-inline">
              {activeRun && (
                <button
                  className="swf-text-button"
                  onClick={() => void showRun(flow.id, activeRun.id)}
                >
                  <Icon name={activeRun.status === "waiting" ? "Clock3" : "Loader2"} size={13} />
                  {activeRun.status === "waiting" ? "Run needs attention" : "Run in progress"}
                </button>
              )}
              <button
                className={`swf-validation-status ${errorCount ? "has-errors" : ""}`}
                onClick={() => {
                  setSelectedId(undefined);
                  setBuilderTab("builder");
                }}
              >
                <Icon name={errorCount ? "CircleAlert" : "CheckCircle2"} size={13} />
                {errorCount
                  ? `${errorCount} ${errorCount === 1 ? "issue" : "issues"} to resolve`
                  : "Ready to test"}
              </button>
              <IconButton
                icon="Download"
                label="Export workflow JSON"
                onClick={() => exportFlow(flow)}
              />
            </div>
          </div>
          {builderTab === "app" ? (
            <AppStudio
              key={flow.id}
              flow={flow}
              runs={runs}
              onRun={(inputs) => startRun(inputs, flow, "manual", false, false)}
              onShowRun={(id) => void showRun(flow.id, id)}
              onEdit={() => setBuilderTab("form")}
            />
          ) : builderTab === "form" ? (
            <AppFormEditor
              flow={flow}
              onChange={(app) => updateFlow(flow.id, (f) => ({ ...f, app }), true)}
            />
          ) : builderTab === "builder" ? (
            <div className="swf-studio">
              <WorkflowCanvas
                key={flow.id}
                flow={flow}
                selectedId={selectedId}
                issueIds={issueIds}
                run={activeRun}
                onSelect={setSelectedId}
                onMove={(nodes, mark) =>
                  mark ? checkpoint(flow) : graphChange({ nodes, edges: flow.edges }, false)
                }
                onConnect={(c) => connect(c.source, c.target, c.sourceHandle)}
                onDeleteEdges={(ids) =>
                  graphChange({
                    nodes: flow.nodes,
                    edges: flow.edges.filter((e) => !ids.includes(e.id)),
                  })
                }
                onAdd={addStep}
                onUndo={() => travel("undo")}
                onRedo={() => travel("redo")}
                onTidy={() =>
                  graphChange({
                    nodes: tidyLayout(flow.nodes, flow.edges),
                    edges: flow.edges,
                  })
                }
                canUndo={!!undo.current[flow.id]?.length}
                canRedo={!!redo.current[flow.id]?.length}
              />
              <StepInspector
                key={selected?.id || "overview"}
                flow={flow}
                step={selected}
                issues={issues}
                connected={!!capabilities?.queue}
                onSelect={setSelectedId}
                onChange={(step) =>
                  graphChange({
                    nodes: flow.nodes.map((n) => (n.id === step.id ? step : n)),
                    edges: flow.edges,
                  })
                }
                onDelete={() => {
                  if (selected && selected.data.kind !== "trigger") {
                    graphChange({
                      nodes: flow.nodes.filter((n) => n.id !== selected.id),
                      edges: flow.edges.filter(
                        (e) => e.source !== selected.id && e.target !== selected.id,
                      ),
                    });
                    setSelectedId(undefined);
                    setToast("Step deleted. Undo is available.");
                  }
                }}
                onDuplicate={() => {
                  if (selected) {
                    const clone = structuredClone(selected);
                    clone.id = crypto.randomUUID();
                    let output = `${clone.data.output}_copy`;
                    while (flow.nodes.some((n) => n.data.output === output)) output += "2";
                    clone.data.output = output.slice(0, 48);
                    clone.position = {
                      x: clone.position.x + 60,
                      y: clone.position.y + 100,
                    };
                    graphChange({
                      nodes: [...flow.nodes, clone],
                      edges: flow.edges,
                    });
                    setSelectedId(clone.id);
                  }
                }}
                onClose={() => setSelectedId(undefined)}
                onConnect={connect}
                onDeleteEdge={(id) =>
                  graphChange({
                    nodes: flow.nodes,
                    edges: flow.edges.filter((e) => e.id !== id),
                  })
                }
              />
            </div>
          ) : (
            <div className="swf-builder-history">
              <div className="swf-section-heading">
                <div>
                  <h2>Run history</h2>
                  <p>Review inputs, decisions, and outputs from each version.</p>
                </div>
                <Button icon="Play" onClick={() => setRunPanel({ workflowId: flow.id })}>
                  New test
                </Button>
              </div>
              <RunHistory
                runs={runs.filter((r) => r.workflowId === flow.id)}
                onView={(id) => void showRun(flow.id, id)}
              />
            </div>
          )}
        </>
      )}
      {dialog === "new" && (
        <NewWorkflowDialog
          onClose={() => setDialog(null)}
          onTemplate={(id) => addFlow(fromTemplate(id))}
          onCreate={(name, description) => {
            const lower = description?.toLowerCase() || "";
            const template = /privileg|condition|branch|sensitiv/.test(lower)
              ? "triage"
              : /contract|compar|agreement/.test(lower)
                ? "contract"
                : /citati|bluebook/.test(lower)
                  ? "citation"
                  : /depos|testimony/.test(lower)
                    ? "deposition"
                    : /discovery|production/.test(lower)
                      ? "discovery"
                      : "briefing";
            const f = description ? fromTemplate(template) : blankWorkflow(name);
            f.name = name;
            f.createdBy = currentUser.name;
            if (description) {
              f.description = description;
              const prompt = f.nodes.find((n) => n.data.kind === "prompt");
              if (prompt) prompt.data.config.instructions = description;
            }
            addFlow(f);
          }}
        />
      )}
      {flow && dialog === "share" && (
        <ShareDialog
          flow={flow}
          groups={capabilities?.groups || []}
          connected={!!capabilities?.enabled}
          onSave={saveSharing}
          onCopyLink={copyLink}
          onExport={() => exportFlow(flow)}
          onClose={() => setDialog(null)}
        />
      )}
      {flow && dialog === "schedule" && (
        <ScheduleDialog
          flow={flow}
          inputRuns={runs.filter((r) => r.workflowId === flow.id)}
          connected={!!capabilities?.scheduler}
          onSave={saveSchedule}
          onClose={() => setDialog(null)}
        />
      )}
      {flow && dialog === "publish" && (
        <Modal
          title={errorCount ? "Resolve issues before publishing" : "Publish workflow"}
          description={flow.name}
          onClose={() => setDialog(null)}
        >
          <div className="swf-modal-body">
            {errorCount ? (
              <>
                {issues
                  .filter((i) => i.severity === "error")
                  .map((i, idx) => (
                    <button
                      className="swf-validation-item error"
                      key={idx}
                      onClick={() => {
                        setDialog(null);
                        setSelectedId(i.nodeId);
                        setBuilderTab("builder");
                      }}
                    >
                      <Icon name="CircleAlert" />
                      <span>{i.message}</span>
                      <Icon name="ChevronRight" />
                    </button>
                  ))}
              </>
            ) : (
              <>
                <div className="swf-publish-preview">
                  <Icon name="CheckCheck" size={26} />
                  <div>
                    <strong>Version {flow.version + 1} is ready</strong>
                    <p>
                      {flow.nodes.length} steps · {flow.edges.length} connections ·{" "}
                      {flow.sharing.visibility === "private"
                        ? "Private"
                        : flow.sharing.teams.join(", ")}
                    </p>
                  </div>
                </div>
                <p className="swf-body-muted">
                  Publishing saves a version for scheduled runs. You can keep editing the draft and
                  publish another version when it's ready.
                </p>
                {issues.filter((i) => i.severity === "warning").length > 0 && (
                  <Notice tone="warning">
                    Some tools require a configured server service. Test those connections before
                    enabling scheduled runs.
                  </Notice>
                )}
                <Notice>
                  {capabilities?.enabled
                    ? "Publishing saves an immutable server version used by scheduled runs."
                    : "Workflow storage is unavailable."}
                </Notice>
              </>
            )}
            {publishError && <Notice tone="error">{publishError}</Notice>}
          </div>
          <div className="swf-modal-footer">
            <Button onClick={() => setDialog(null)}>
              {errorCount ? "Back to builder" : "Cancel"}
            </Button>
            {!errorCount && (
              <Button
                variant="primary"
                icon="Check"
                disabled={publishing}
                onClick={() => void publish()}
              >
                {publishing ? "Publishing…" : `Publish version ${flow.version + 1}`}
              </Button>
            )}
          </div>
        </Modal>
      )}
      {dialog === "about" && (
        <Modal
          title="Workflow services"
          description="Your authenticated Seeger Weiss workspace"
          onClose={() => setDialog(null)}
        >
          <div className="swf-modal-body">
            <Notice>
              Definitions and runs are stored in your platform’s private AWS storage. Document
              analysis uses the configured Bedrock model. Source checks do not establish legal
              correctness.
            </Notice>
            <div className="swf-overview-facts">
              <span>
                Workflow worker
                <strong>{capabilities?.queue ? "Configured" : "Not configured"}</strong>
              </span>
              <span>
                Unattended schedules
                <strong>{capabilities?.scheduler ? "Configured" : "Not configured"}</strong>
              </span>
              <span>
                Isolated Python
                <strong>{capabilities?.python ? "Configured" : "Not configured"}</strong>
              </span>
              <span>
                Sharing<strong>Cognito group permissions</strong>
              </span>
            </div>
            <p className="swf-body-muted">
              Outlook and Box require an approved server connector. Notifications are message
              drafts, with no email delivery. Configuration does not guarantee provider
              availability; run history records failures.
            </p>
          </div>
        </Modal>
      )}
      {deleteId && (
        <Modal
          title="Delete workflow?"
          description={flows.find((f) => f.id === deleteId)?.name}
          onClose={() => setDeleteId(undefined)}
        >
          <div className="swf-modal-body">
            <p>
              This archives the workflow, withdraws access, and disables its schedule. Stored run
              records follow your platform retention policy.
            </p>
          </div>
          <div className="swf-modal-footer">
            <Button onClick={() => setDeleteId(undefined)}>Cancel</Button>
            <Button variant="danger" icon="Trash2" onClick={() => void removeWorkflow(deleteId)}>
              Delete workflow
            </Button>
          </div>
        </Modal>
      )}
      {runPanel && (
        <RunPanel
          key={`${runPanel.workflowId}-${runPanel.runId || "new"}`}
          flow={flows.find((f) => f.id === runPanel.workflowId)}
          run={currentRun}
          connected={!!capabilities?.queue}
          onStart={async (inputs) => {
            const f = flows.find((f) => f.id === runPanel.workflowId);
            if (f) await startRun(inputs, f);
          }}
          onCancel={cancelRun}
          onReview={approve}
          onClose={() => setRunPanel(undefined)}
          onNewTest={() => setRunPanel({ workflowId: runPanel.workflowId })}
        />
      )}
      {toast && (
        <div className="swf-toast" role="status">
          <Icon name="Info" />
          <span>{toast}</span>
          <IconButton icon="X" label="Dismiss notification" onClick={() => setToast("")} />
        </div>
      )}
    </div>
  );
}
