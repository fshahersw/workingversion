import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { definition } from "./catalog";
import { displayValue } from "./engine";
import { SourcePicker } from "./SourcePicker";
import { downloadArtifact, downloadBlob, readSourceBatch } from "./files";
import { Badge, Button, Icon, IconButton, Notice, Tile, statusTone, timeLabel } from "./ui";
import type { Artifact, RunInputs, SourceFile, Workflow, WorkflowRun } from "./types";

type Props = {
  flow?: Workflow;
  run?: WorkflowRun;
  connected: boolean;
  onStart: (inputs: RunInputs) => Promise<void>;
  onCancel: () => void;
  onReview: (approved: boolean, notes: string) => void;
  onClose: () => void;
  onNewTest: () => void;
};
export function RunPanel(props: Props) {
  const [inputs, setInputs] = useState<RunInputs>({
    text: "",
    matter: "",
    selection:
      props.flow?.nodes.find((n) => n.data.kind === "selection")?.data.config.options?.[0] ||
      "Standard",
    files: [],
    fields: Object.fromEntries((props.flow?.app?.fields || []).map((f) => [f.id, f.value || ""])),
  });
  const [tab, setTab] = useState("activity"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [notes, setNotes] = useState(""),
    [preview, setPreview] = useState<Artifact>();
  const fileRef = useRef<HTMLInputElement>(null),
    { run, flow } = props;
  const [coverageReviewed, setCoverageReviewed] = useState(false);
  const hasWarnings = inputs.files.some((f) => f.metadata?.warnings.length);
  const acceptsNoFiles = flow?.nodes.some((n) =>
    ["web", "scrape", "search", "mcp"].includes(n.data.kind),
  );
  const waiting = run?.graph.nodes.find((n) => run.results[n.id]?.status === "waiting");
  const selectionOptions = [
    ...new Set(
      flow?.nodes
        .filter((n) => n.data.kind === "selection")
        .flatMap((n) => n.data.config.options || []) || [],
    ),
  ];
  const download = async (artifact: Artifact) => {
    try {
      await downloadArtifact(artifact);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be generated.");
    }
  };
  const addFiles = async (files: File[]) => {
    setLoading(true);
    setError("");
    try {
      if (inputs.files.length + files.length > 20)
        throw new Error("Use at most 20 source files in one run. No files were added.");
      const parsed: SourceFile[] = await readSourceBatch(files);
      setCoverageReviewed(false);
      setInputs((prev) => ({
        ...prev,
        files: [...prev.files, ...parsed],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <div className="swf-root swf-portal">
          <Dialog.Overlay className="swf-run-overlay" />
          <Dialog.Content className="swf-run-panel" aria-describedby="swf-run-description">
            <div className="swf-run-heading">
              <div className="swf-inline">
                <Tile icon={run ? "WorkflowIcon" : "Play"} tone="teal" />
                <div>
                  <Dialog.Title>{run ? "Workflow run" : "Test workflow"}</Dialog.Title>
                  <Dialog.Description id="swf-run-description">
                    {run?.workflowName || flow?.name}
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <IconButton icon="X" label="Close run panel" />
              </Dialog.Close>
            </div>
            {!run ? (
              <>
                <div className="swf-run-scroll">
                  <div className="swf-run-intro">
                    <Badge tone="blue">Draft test</Badge>
                    <p>Supply documents or text and follow each step as it runs.</p>
                  </div>
                  <label className="swf-field">
                    Matter name
                    <input
                      value={inputs.matter}
                      onChange={(e) => setInputs({ ...inputs, matter: e.target.value })}
                      maxLength={200}
                    />
                  </label>
                  <div className="swf-field">
                    Source documents
                    <SourcePicker
                      busy={loading}
                      onFiles={(files) => {
                        setCoverageReviewed(false);
                        setInputs({ ...inputs, files, text: "" });
                      }}
                    />
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      accept=".pdf,.docx,.eml,.txt,.md,.csv,.tsv,.json"
                      hidden
                      onChange={(e) => {
                        if (e.target.files) void addFiles(Array.from(e.target.files));
                        e.target.value = "";
                      }}
                    />
                    <button
                      className="swf-dropzone"
                      onClick={() => fileRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void addFiles(Array.from(e.dataTransfer.files));
                      }}
                      disabled={loading}
                    >
                      <Icon
                        name={loading ? "Loader2" : "FileUp"}
                        size={24}
                        className={loading ? "swf-spin" : ""}
                      />
                      <strong>
                        {loading ? "Reading your files…" : "Drop files here or browse"}
                      </strong>
                      <span>PDF, DOCX, EML, TXT, Markdown, CSV / TSV, JSON · up to 20 MB each</span>
                    </button>
                    {inputs.files.map((f) => (
                      <div className="swf-uploaded-file" key={f.id}>
                        <Icon name="FileText" />
                        <span>
                          {f.name}
                          <small>{f.text.length.toLocaleString()} characters</small>
                          {f.metadata?.warnings.map((w, i) => (
                            <small key={i}>{w}</small>
                          ))}
                        </span>
                        <IconButton
                          icon="X"
                          label={`Remove ${f.name}`}
                          onClick={() =>
                            setInputs({
                              ...inputs,
                              files: inputs.files.filter((v) => v.id !== f.id),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <label className="swf-field">
                    {inputs.files.length ? "Additional context" : "Source text"}
                    <textarea
                      rows={9}
                      value={inputs.text}
                      maxLength={1000000}
                      onChange={(e) => setInputs({ ...inputs, text: e.target.value })}
                    />
                  </label>
                  {selectionOptions.length > 0 && (
                    <label className="swf-field">
                      Workflow choice
                      <select
                        value={inputs.selection}
                        onChange={(e) => setInputs({ ...inputs, selection: e.target.value })}
                      >
                        {selectionOptions.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(flow?.app?.fields || []).map((field) => (
                    <label className="swf-field" key={field.id}>
                      {field.label}
                      {field.required ? " *" : ""}
                      {field.type === "select" ? (
                        <select
                          value={inputs.fields?.[field.id] || ""}
                          onChange={(e) =>
                            setInputs({
                              ...inputs,
                              fields: { ...inputs.fields, [field.id]: e.target.value },
                            })
                          }
                        >
                          <option value="">Choose an option</option>
                          {field.options?.map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      ) : field.type === "textarea" ? (
                        <textarea
                          rows={3}
                          maxLength={20000}
                          value={inputs.fields?.[field.id] || ""}
                          onChange={(e) =>
                            setInputs({
                              ...inputs,
                              fields: { ...inputs.fields, [field.id]: e.target.value },
                            })
                          }
                        />
                      ) : (
                        <input
                          type={field.type === "date" ? "date" : "text"}
                          maxLength={20000}
                          value={inputs.fields?.[field.id] || ""}
                          onChange={(e) =>
                            setInputs({
                              ...inputs,
                              fields: { ...inputs.fields, [field.id]: e.target.value },
                            })
                          }
                        />
                      )}
                    </label>
                  ))}
                  {hasWarnings && (
                    <label className="swf-inline">
                      <input
                        type="checkbox"
                        checked={coverageReviewed}
                        onChange={(e) => setCoverageReviewed(e.target.checked)}
                      />
                      I reviewed the extraction warnings and accept the source coverage for this
                      run.
                    </label>
                  )}
                  <Notice>
                    {props.connected
                      ? "Runs continue on your platform’s server. Inputs and results are retained in the workspace."
                      : "The workflow worker is not configured."}
                  </Notice>
                  {flow?.nodes.some((n) => n.data.kind === "compare") && (
                    <Notice>Document comparison needs at least two uploaded source files.</Notice>
                  )}
                  {error && <Notice tone="error">{error}</Notice>}
                </div>
                <div className="swf-run-footer">
                  <span>
                    <Icon name="LockKeyhole" size={13} />
                    {props.connected ? "Authenticated server execution" : "Worker unavailable"}
                  </span>
                  <Button
                    variant="primary"
                    icon="Play"
                    disabled={
                      loading ||
                      !props.connected ||
                      (hasWarnings && !coverageReviewed) ||
                      (!acceptsNoFiles && !inputs.text.trim() && !inputs.files.length)
                    }
                    onClick={async () => {
                      setLoading(true);
                      try {
                        await props.onStart({
                          ...inputs,
                          fields: {
                            ...inputs.fields,
                            coverageAcknowledged: String(coverageReviewed),
                          },
                        });
                        setTab("activity");
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Run could not start.");
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Start test run
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="swf-run-summary">
                  <div>
                    <Badge tone={statusTone(run.status)}>
                      <Icon
                        name={
                          run.status === "running"
                            ? "Loader2"
                            : run.status === "completed"
                              ? "CheckCircle2"
                              : run.status === "waiting"
                                ? "Clock3"
                                : "Circle"
                        }
                        size={12}
                        className={run.status === "running" ? "swf-spin" : ""}
                      />
                      {run.status === "waiting" ? "Waiting for action" : run.status}
                    </Badge>
                    <span>{run.mode === "local" ? "Server execution" : "Connected tools"}</span>
                  </div>
                  <p>
                    {timeLabel(run.startedAt)} <i>·</i> {run.id.slice(0, 8)}
                  </p>
                </div>
                <div className="swf-run-tabs">
                  {[
                    { id: "activity", label: "Activity" },
                    {
                      id: "outputs",
                      label: `Outputs${run.artifacts.length ? ` (${run.artifacts.length})` : ""}`,
                    },
                    { id: "inputs", label: "Inputs" },
                  ].map((t) => (
                    <button
                      className={tab === t.id ? "active" : ""}
                      onClick={() => {
                        setTab(t.id);
                        setPreview(undefined);
                      }}
                      key={t.id}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="swf-run-scroll">
                  {tab === "activity" && (
                    <>
                      {run.status === "waiting" && waiting?.data.kind === "review" && (
                        <div className="swf-review-box">
                          <div className="swf-inline">
                            <Tile icon="UserRoundCheck" tone="amber" small />
                            <strong>Review required</strong>
                          </div>
                          <p>{waiting.data.config.instructions}</p>
                          <div className="swf-review-assignee">
                            <Icon name="Users" size={14} />
                            Assigned to {waiting.data.config.reviewer}
                          </div>
                          <label className="swf-field">
                            Review notes
                            <textarea
                              rows={3}
                              value={notes}
                              onChange={(e) => setNotes(e.target.value)}
                              placeholder="Record your decision and any follow-up…"
                            />
                          </label>
                          <div className="swf-inline">
                            <Button
                              variant="primary"
                              icon="Check"
                              onClick={() => props.onReview(true, notes)}
                            >
                              Approve & continue
                            </Button>
                            <Button variant="danger" onClick={() => props.onReview(false, notes)}>
                              Reject
                            </Button>
                          </div>
                          <small>Preview: you are acting as the assigned reviewer.</small>
                        </div>
                      )}
                      {run.status === "waiting" && waiting?.data.kind === "delay" && (
                        <Notice tone="warning">
                          Paused until{" "}
                          {new Date(run.results[waiting.id].resumeAt || "").toLocaleTimeString()}.
                          The runner resumes while this page is open.
                        </Notice>
                      )}
                      <div className="swf-run-steps">
                        {run.graph.nodes.map((n, i) => {
                          const result = run.results[n.id];
                          return (
                            <details
                              key={n.id}
                              className={`swf-run-step ${result.status}`}
                              open={result.status === "failed" ? true : undefined}
                            >
                              <summary>
                                <span className={`swf-step-status ${result.status}`}>
                                  <Icon
                                    name={
                                      result.status === "completed"
                                        ? "Check"
                                        : result.status === "running"
                                          ? "Loader2"
                                          : result.status === "waiting"
                                            ? "Clock3"
                                            : result.status === "failed"
                                              ? "X"
                                              : result.status === "skipped"
                                                ? "Minus"
                                                : "Circle"
                                    }
                                    size={13}
                                    className={result.status === "running" ? "swf-spin" : ""}
                                  />
                                </span>
                                <span>
                                  <strong>{n.data.label}</strong>
                                  <small>
                                    {result.status === "skipped"
                                      ? "Branch not selected"
                                      : result.status === "pending"
                                        ? "Queued"
                                        : result.status === "completed"
                                          ? `${definition(n.data.kind).label} · complete`
                                          : result.status}
                                  </small>
                                </span>
                                <Icon name="ChevronDown" size={14} />
                              </summary>
                              {result.output !== undefined && (
                                <pre className="swf-result-json">{displayValue(result.output)}</pre>
                              )}
                              {result.error && <Notice tone="error">{result.error}</Notice>}
                              {result.output === undefined && !result.error && (
                                <p className="swf-body-muted">
                                  {i === 0
                                    ? "Collecting the workflow's inputs."
                                    : "Output will appear when this step completes."}
                                </p>
                              )}
                            </details>
                          );
                        })}
                      </div>
                      {run.artifacts.length > 0 && (
                        <div className="swf-completion-card">
                          <div className="swf-inline">
                            <Tile icon="FileCheck2" tone="green" />
                            <div>
                              <strong>
                                {run.artifacts.length}{" "}
                                {run.artifacts.length === 1 ? "file" : "files"} created
                              </strong>
                              <p>Ready for your review.</p>
                            </div>
                          </div>
                          <Button icon="ArrowRight" onClick={() => setTab("outputs")}>
                            View outputs
                          </Button>
                        </div>
                      )}
                      <details className="swf-event-log">
                        <summary>
                          Event log <span>{run.logs.length} events</span>
                        </summary>
                        {run.logs.map((log) => (
                          <p key={log.id}>
                            <time>
                              {new Date(log.time).toLocaleTimeString("en-US", {
                                hour12: false,
                              })}
                            </time>
                            <span className={log.level}>{log.message}</span>
                          </p>
                        ))}
                      </details>
                    </>
                  )}
                  {tab === "outputs" && (
                    <>
                      {preview ? (
                        <div className="swf-artifact-preview">
                          <Button
                            variant="ghost"
                            icon="ArrowLeft"
                            onClick={() => setPreview(undefined)}
                          >
                            All outputs
                          </Button>
                          <h3>{preview.name}</h3>
                          <pre>{preview.content}</pre>
                          <Button
                            icon="Download"
                            variant="primary"
                            onClick={() => void download(preview)}
                          >
                            Download {preview.format.toUpperCase()}
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="swf-section-heading">
                            <div>
                              <h3>Generated files</h3>
                              <p>Open a file to preview its content.</p>
                            </div>
                          </div>
                          {run.artifacts.map((a) => (
                            <div className="swf-artifact" key={a.id}>
                              <button onClick={() => setPreview(a)}>
                                <Tile
                                  icon={a.format === "csv" ? "Table2" : "FileText"}
                                  tone={a.format === "csv" ? "amber" : "blue"}
                                />
                                <span>
                                  <strong>{a.name}</strong>
                                  <small>{a.format.toUpperCase()} · Draft for review</small>
                                </span>
                              </button>
                              <IconButton
                                icon="Download"
                                label={`Download ${a.name}`}
                                onClick={() => void download(a)}
                              />
                            </div>
                          ))}
                          {!run.artifacts.length && (
                            <div className="swf-empty">
                              <Icon name="Files" size={25} />
                              <h3>No files yet</h3>
                              <p>
                                Add a Create document or Tabular review step to produce a
                                downloadable file.
                              </p>
                            </div>
                          )}
                          <h4>Final response</h4>
                          <pre className="swf-result-json">
                            {displayValue(
                              Object.values(run.results)
                                .reverse()
                                .find((r) => r.status === "completed" && r.output)?.output ||
                                "The response will appear when a step completes.",
                            )}
                          </pre>
                        </>
                      )}
                    </>
                  )}
                  {tab === "inputs" && (
                    <>
                      <div className="swf-overview-facts">
                        <span>
                          Matter
                          <strong>{run.inputs.matter || "Not provided"}</strong>
                        </span>
                        <span>
                          Choice<strong>{run.inputs.selection}</strong>
                        </span>
                        <span>
                          Source files<strong>{run.inputs.files.length}</strong>
                        </span>
                      </div>
                      <h4>Source text</h4>
                      <pre className="swf-result-json">{run.inputs.text}</pre>
                      {run.inputs.files.map((f) => (
                        <details className="swf-event-log" key={f.id}>
                          <summary>
                            <Icon name="FileText" />
                            {f.name}
                          </summary>
                          <pre className="swf-result-json">{f.text}</pre>
                        </details>
                      ))}
                    </>
                  )}
                  {error && <Notice tone="error">{error}</Notice>}
                </div>
                <div className="swf-run-footer">
                  <Button
                    icon="Download"
                    variant="ghost"
                    onClick={() =>
                      downloadBlob(
                        `workflow-run-${run.id.slice(0, 8)}.json`,
                        new Blob([JSON.stringify(run, null, 2)], {
                          type: "application/json",
                        }),
                      )
                    }
                  >
                    Export run
                  </Button>
                  {["running", "waiting"].includes(run.status) ? (
                    <Button icon="Square" onClick={props.onCancel}>
                      Cancel run
                    </Button>
                  ) : (
                    flow && (
                      <Button
                        icon="Play"
                        variant="primary"
                        onClick={() => {
                          props.onNewTest();
                          setNotes("");
                          setError("");
                        }}
                      >
                        New test
                      </Button>
                    )
                  )}
                </div>
              </>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
