import { useState } from "react";
import { ancestors, canConnect } from "./graph";
import { definition } from "./catalog";
import { recipeNames } from "./recipes";
import { WorkspaceChoice } from "./SourcePicker";
import { Badge, Button, Icon, IconButton, Notice, Tile } from "./ui";
import type { StepConfig, Workflow, WorkflowStep, ValidationIssue } from "./types";

type Props = {
  flow: Workflow;
  step?: WorkflowStep;
  issues: ValidationIssue[];
  connected: boolean;
  onChange: (step: WorkflowStep) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onConnect: (source: string, target: string, handle?: string) => void;
  onDeleteEdge: (id: string) => void;
  onSelect: (id: string) => void;
};
export function StepInspector(props: Props) {
  const { flow, step } = props;
  const [tab, setTab] = useState<"settings" | "connections">("settings");
  const [target, setTarget] = useState("");
  const [branch, setBranch] = useState("true");
  if (!step)
    return (
      <aside className="swf-inspector">
        <div className="swf-panel-heading">
          <strong>Workflow overview</strong>
          <Icon name="Settings2" />
        </div>
        <div className="swf-inspector-scroll">
          <Tile icon="WorkflowIcon" tone="teal" />
          <h3 className="swf-inspector-title">{flow.name}</h3>
          <p className="swf-body-muted">{flow.description}</p>
          <div className="swf-overview-facts">
            <span>
              Steps<strong>{flow.nodes.length}</strong>
            </span>
            <span>
              Connections<strong>{flow.edges.length}</strong>
            </span>
            <span>
              Owner<strong>{flow.createdBy}</strong>
            </span>
          </div>
          <Notice>Select a step to configure its inputs, instructions, and connections.</Notice>
          <section className="swf-field-section">
            <h4>Workflow check</h4>
            {props.issues.length ? (
              props.issues.map((i, idx) => (
                <button
                  className={`swf-validation-item ${i.severity}`}
                  key={idx}
                  onClick={() => i.nodeId && props.onSelect(i.nodeId)}
                >
                  <Icon name="CircleAlert" size={15} />
                  <span>{i.message}</span>
                </button>
              ))
            ) : (
              <p className="swf-check-ok">
                <Icon name="CheckCircle2" />
                Ready for a test run
              </p>
            )}
          </section>
          <div className="swf-local-note">
            <Icon name="ShieldCheck" />
            <p>
              Drafts and runs use your private platform workspace. Save draft changes before leaving
              this page.
            </p>
          </div>
        </div>
      </aside>
    );
  const d = definition(step.data.kind),
    config = step.data.config;
  const update = (patch: StepConfig) =>
    props.onChange({
      ...step,
      data: { ...step.data, config: { ...config, ...patch } },
    });
  const updateData = (patch: Partial<WorkflowStep["data"]>) =>
    props.onChange({ ...step, data: { ...step.data, ...patch } });
  const upstream = ancestors(step.id, flow.nodes, flow.edges);
  const listField = (label: string, key: "fields" | "options" | "recipients", hint: string) => (
    <label className="swf-field">
      {label}
      <textarea
        rows={4}
        value={(config[key] || []).join("\n")}
        onChange={(e) => update({ [key]: e.target.value.split("\n") })}
        onBlur={() =>
          update({
            [key]: (config[key] || []).map((x) => x.trim()).filter(Boolean),
          })
        }
      />{" "}
      <small>{hint}</small>
    </label>
  );
  const instructionField = (
    <label className="swf-field">
      {step.data.kind === "review" ? "Review instructions" : "Instructions"}
      <textarea
        className="swf-prompt-input"
        rows={7}
        value={config.instructions || ""}
        onChange={(e) => update({ instructions: e.target.value })}
        placeholder="Describe what this step should do…"
      />
      <small>Use {"{{output_name.field}}"} to reference an earlier result.</small>
    </label>
  );
  return (
    <aside className="swf-inspector has-step" aria-label="Step configuration">
      <div className="swf-panel-heading">
        <div className="swf-inline">
          <Tile icon={d.icon} tone={d.tone} small />
          <strong>{d.label}</strong>
        </div>
        <IconButton icon="X" label="Close step settings" onClick={props.onClose} />
      </div>
      <div className="swf-panel-tabs">
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          Configure
        </button>
        <button
          className={tab === "connections" ? "active" : ""}
          onClick={() => setTab("connections")}
        >
          Connections{" "}
          <span>
            {flow.edges.filter((e) => e.source === step.id || e.target === step.id).length}
          </span>
        </button>
      </div>
      <div className="swf-inspector-scroll">
        {tab === "settings" ? (
          <>
            <label className="swf-field">
              Step name
              <input
                value={step.data.label}
                maxLength={80}
                onChange={(e) => updateData({ label: e.target.value })}
              />
            </label>
            {props.issues
              .filter((i) => i.nodeId === step.id && i.severity === "error")
              .map((i, idx) => (
                <Notice tone="error" key={idx}>
                  {i.message}
                </Notice>
              ))}
            <div className="swf-field-section">
              {step.data.kind === "recipe" && (
                <>
                  <label className="swf-field">
                    Analysis mode
                    <select
                      value={config.model || "bedrock"}
                      onChange={(e) => update({ model: e.target.value })}
                    >
                      <option value="local">Deterministic source checks</option>
                      <option value="bedrock">Approved host AI · evidence required</option>
                    </select>
                    <small>
                      Host AI requires an authenticated evidence-checking service. Deterministic
                      checks remain available without a model.
                    </small>
                  </label>
                  {instructionField}
                  <label className="swf-field">
                    Analysis recipe
                    <select
                      value={config.recipe || "parties"}
                      onChange={(e) => update({ recipe: e.target.value })}
                    >
                      {Object.entries(recipeNames).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Deterministic rules extract evidence from supplied text. Semantic analysis can
                      be added as a separate AI step.
                    </small>
                  </label>
                  <label className="swf-field">
                    Default topics (comma-separated)
                    <textarea
                      rows={3}
                      value={config.query || ""}
                      onChange={(e) => update({ query: e.target.value })}
                    />
                  </label>
                  <label className="swf-field">
                    Default field labels
                    <input
                      value={(config.fields || []).join(", ")}
                      onChange={(e) =>
                        update({
                          fields: e.target.value
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <Notice>
                    Use the Mini app tab for source-linked tables. App-form values override the
                    corresponding recipe defaults.
                  </Notice>
                </>
              )}
              {["web", "scrape"].includes(step.data.kind) && (
                <>
                  <label className="swf-field">
                    Connection
                    <select
                      value={config.connection || "public-web"}
                      onChange={(e) => update({ connection: e.target.value })}
                    >
                      {step.data.kind === "web" ? (
                        <>
                          <option value="wikipedia">Wikipedia reference search · no key</option>
                          <option value="firecrawl">Firecrawl · server API key</option>
                        </>
                      ) : (
                        <option value="public-web">Public HTTPS reader</option>
                      )}
                    </select>
                  </label>
                  <label className="swf-field">
                    {step.data.kind === "web" ? "Query" : "Public URL"}
                    <input
                      value={step.data.kind === "web" ? config.query || "" : config.url || ""}
                      onChange={(e) =>
                        update(
                          step.data.kind === "web"
                            ? { query: e.target.value }
                            : { url: e.target.value },
                        )
                      }
                    />
                  </label>
                  <Notice>
                    Uses the platform’s approved web service. Browser-side step settings contain no
                    API keys.
                  </Notice>
                </>
              )}
              {step.data.kind === "trigger" && (
                <>
                  <h4>How this workflow starts</h4>
                  <div className="swf-setting-card">
                    <Icon name="Play" />
                    <div>
                      <strong>Manual run</strong>
                      <p>A user provides source files or text.</p>
                    </div>
                    <Badge tone="green">Ready</Badge>
                  </div>
                  <div className="swf-setting-card">
                    <Icon name="CalendarClock" />
                    <div>
                      <strong>Scheduled run</strong>
                      <p>Configure timing from the Schedule button.</p>
                    </div>
                  </div>
                  <Notice>
                    Publish a version before enabling a schedule. Test runs use your current draft.
                  </Notice>
                </>
              )}
              {step.data.kind === "files" && (
                <>
                  <h4>Source documents</h4>
                  <div className="swf-setting-card">
                    <Icon name="FileUp" />
                    <div>
                      <strong>Request files at run time</strong>
                      <p>PDF, DOCX, EML, TXT, Markdown, CSV / TSV, JSON</p>
                    </div>
                  </div>
                  <p className="swf-body-muted">
                    The run panel collects and parses your files. Source limits: 20 MB per file, 300
                    PDF pages, and 1,000,000 characters per run.
                  </p>
                  <Notice>
                    Scanned PDFs and additional formats need a document-parsing service from your
                    host platform.
                  </Notice>
                </>
              )}
              {step.data.kind === "text" && (
                <label className="swf-field">
                  Default text
                  <textarea
                    rows={7}
                    value={config.value || ""}
                    onChange={(e) => update({ value: e.target.value })}
                    placeholder="Leave empty to use the text supplied at run time."
                  />
                  <small>Used as this step's output. Reference it in later prompts.</small>
                </label>
              )}
              {step.data.kind === "selection" &&
                listField(
                  "Choices",
                  "options",
                  "One choice per line. Users select an option before running.",
                )}
              {["prompt", "agent"].includes(step.data.kind) && (
                <>
                  <label className="swf-field">
                    Model
                    <select
                      value={config.model || (step.data.kind === "recipe" ? "local" : "bedrock")}
                      onChange={(e) => update({ model: e.target.value })}
                    >
                      <option value="bedrock">Amazon Bedrock · approved model</option>
                    </select>
                    <small>
                      The approved model is selected by your platform’s server configuration.
                    </small>
                  </label>
                  {instructionField}
                  <label className="swf-field">
                    Context from earlier steps
                    <div className="swf-context-list">
                      {upstream.length ? (
                        upstream.map((n) => (
                          <label className="swf-context-option" key={n.id}>
                            <input
                              type="checkbox"
                              checked={config.context?.includes(n.data.output) || false}
                              onChange={(e) =>
                                update({
                                  context: e.target.checked
                                    ? [...(config.context || []), n.data.output]
                                    : config.context?.filter((v) => v !== n.data.output),
                                })
                              }
                            />
                            <Icon name={definition(n.data.kind).icon} size={14} />
                            <code>{n.data.output}</code>
                          </label>
                        ))
                      ) : (
                        <span className="swf-body-muted">
                          Connect an earlier step to use its output.
                        </span>
                      )}
                    </div>
                  </label>
                  {step.data.kind === "agent" && (
                    <label className="swf-field">
                      Allowed tool group
                      <input
                        value={config.tool || ""}
                        onChange={(e) => update({ tool: e.target.value })}
                        placeholder="Document analysis"
                      />
                      <small>Your host controls which tools this agent may call.</small>
                    </label>
                  )}
                </>
              )}
              {step.data.kind === "extract" && (
                <>
                  {listField(
                    "Fields to extract",
                    "fields",
                    "One field per line. Results include an evidence table and fields; unknown values remain null.",
                  )}
                  <Notice>
                    Extracted facts retain their source documents. Date and citation validation
                    belong in a separate review step.
                  </Notice>
                </>
              )}
              {step.data.kind === "table" && (
                <>
                  {listField(
                    "Review columns",
                    "fields",
                    "One column per line. Each source document becomes a row.",
                  )}
                  <div className="swf-setting-card">
                    <Icon name="Table2" />
                    <div>
                      <strong>Downloadable CSV</strong>
                      <p>Created automatically when this step runs.</p>
                    </div>
                  </div>
                </>
              )}
              {step.data.kind === "condition" && (
                <>
                  <label className="swf-field">
                    Compare a field
                    <input
                      list={`swf-fields-${step.id}`}
                      value={config.left || ""}
                      onChange={(e) => update({ left: e.target.value })}
                      placeholder="extraction.privileged"
                    />
                    <datalist id={`swf-fields-${step.id}`}>
                      {upstream
                        .flatMap((n) => [
                          n.data.output,
                          ...(n.data.config.fields || []).map((f) => `${n.data.output}.${f}`),
                          ...(n.data.kind === "trigger"
                            ? ["text", "selection", "matter", "fileCount"].map(
                                (f) => `${n.data.output}.${f}`,
                              )
                            : []),
                          ...(n.data.kind === "selection" ? [`${n.data.output}.selection`] : []),
                        ])
                        .map((field) => (
                          <option value={field} key={field} />
                        ))}
                    </datalist>
                    <small>Use an output name followed by a field, separated by a dot.</small>
                  </label>
                  <label className="swf-field">
                    Condition
                    <select
                      value={config.operator || "is_true"}
                      onChange={(e) =>
                        update({
                          operator: e.target.value as StepConfig["operator"],
                        })
                      }
                    >
                      <option value="is_true">Is true</option>
                      <option value="equals">Equals</option>
                      <option value="contains">Contains</option>
                      <option value="greater_than">Is greater than</option>
                      <option value="exists">Has a value</option>
                    </select>
                  </label>
                  {!["is_true", "exists"].includes(config.operator || "") && (
                    <label className="swf-field">
                      Compare with
                      <input
                        value={config.right || ""}
                        onChange={(e) => update({ right: e.target.value })}
                      />
                    </label>
                  )}
                  <div className="swf-branch-preview">
                    <span>
                      <i className="swf-dot swf-green" />
                      True branch
                    </span>
                    <span>
                      <i className="swf-dot swf-amber" />
                      False branch
                    </span>
                  </div>
                  <p className="swf-body-muted">
                    Only the matching branch runs. Connect each branch to its next step.
                  </p>
                </>
              )}
              {step.data.kind === "review" && (
                <>
                  <label className="swf-field">
                    Assigned reviewer
                    <input
                      value={config.reviewer || "owner"}
                      onChange={(e) => update({ reviewer: e.target.value })}
                      placeholder="owner or reviewer@your-firm.com"
                    />
                  </label>
                  {instructionField}
                  <Notice>
                    Execution pauses here until a user approves or rejects the run. Only the
                    assigned signed-in reviewer can record this decision. The reviewer also needs
                    access to the workflow.
                  </Notice>
                </>
              )}
              {step.data.kind === "document" && (
                <>
                  <label className="swf-field">
                    Document name
                    <input
                      value={config.filename || ""}
                      onChange={(e) => update({ filename: e.target.value })}
                    />
                  </label>
                  <label className="swf-field">
                    File format
                    <select
                      value={config.format || "docx"}
                      onChange={(e) =>
                        update({
                          format: e.target.value as StepConfig["format"],
                        })
                      }
                    >
                      <option value="docx">Word document (.docx)</option>
                      <option value="pdf">PDF document (.pdf)</option>
                      <option value="txt">Plain text (.txt)</option>
                    </select>
                  </label>
                  {instructionField}
                </>
              )}
              {step.data.kind === "delay" && (
                <>
                  <label className="swf-field">
                    Wait duration, in seconds
                    <input
                      type="number"
                      min={1}
                      max={2592000}
                      value={config.seconds ?? 10}
                      onChange={(e) => update({ seconds: Number(e.target.value) })}
                    />
                  </label>
                  <Notice>
                    The server worker resumes after the wait, even when this page is closed.
                  </Notice>
                </>
              )}
              {["search", "mcp"].includes(step.data.kind) && (
                <>
                  <label className="swf-field">
                    Connection ID
                    <input
                      value={config.connection || ""}
                      onChange={(e) => update({ connection: e.target.value })}
                      placeholder="docketbird"
                    />
                    <small>
                      Use docketbird for the approved read-only docket tools. Other apps require a
                      registered server connection ID. Credentials stay on your server.
                    </small>
                  </label>
                  {step.data.kind === "search" && config.connection === "workspace" && (
                    <WorkspaceChoice
                      value={config.value || ""}
                      onChange={(value) => update({ value })}
                    />
                  )}
                  {step.data.kind === "mcp" && (
                    <label className="swf-field">
                      Tool name
                      <input
                        value={config.tool || ""}
                        onChange={(e) => update({ tool: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="swf-field">
                    Search query
                    <input
                      value={config.query || ""}
                      onChange={(e) => update({ query: e.target.value })}
                      placeholder="discovery"
                    />
                  </label>
                  <Notice>
                    {config.connection === "docketbird"
                      ? "Uses the platform’s configured Docketbird account."
                      : "This connection runs through your host execution adapter."}
                  </Notice>
                </>
              )}
              {step.data.kind === "python" && (
                <>
                  <label className="swf-field">
                    Runtime connection
                    <input
                      value={config.connection || ""}
                      onChange={(e) => update({ connection: e.target.value })}
                      placeholder="approved-python-sandbox"
                    />
                  </label>
                  <label className="swf-field">
                    Python code
                    <textarea
                      className="swf-code-input"
                      rows={9}
                      value={config.code || ""}
                      onChange={(e) => update({ code: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <Notice>
                    Code is stored with the workflow. Execution requires a isolated server session.
                    Read workflow_inputs.json for this run’s inputs.
                  </Notice>
                </>
              )}
              {step.data.kind === "notify" && (
                <>
                  {listField(
                    "Recipients",
                    "recipients",
                    "One email per line. This step creates an email draft; it does not deliver mail.",
                  )}
                  {instructionField}
                  <Notice>
                    Creates a downloadable email draft. Sending requires an approved service in the
                    host platform.
                  </Notice>
                </>
              )}
              {step.data.kind === "edit" && (
                <>
                  <label className="swf-field">
                    Find text
                    <input
                      value={config.left || ""}
                      onChange={(e) => update({ left: e.target.value })}
                      placeholder="[CLIENT]"
                    />
                  </label>
                  <label className="swf-field">
                    Replace with
                    <input
                      value={config.right || ""}
                      onChange={(e) => update({ right: e.target.value })}
                    />
                  </label>
                  <Notice>
                    Applies an exact replacement to the first source file and creates an edited text
                    file.
                  </Notice>
                </>
              )}
              {step.data.kind === "citations" && (
                <>
                  {instructionField}
                  <Notice>
                    Citation lookup checks the source text for recognized case references. Full
                    format verification requires review; parentheticals. Full Bluebook rules and
                    authority verification require a connected legal service.
                  </Notice>
                </>
              )}
              {step.data.kind === "compare" && (
                <Notice>
                  Supply two source files in the run panel. Evidence-based comparison lists added
                  and removed lines; a connected model can interpret their significance.
                </Notice>
              )}
              {step.data.kind === "foreach" && (
                <Notice>
                  Creates an indexed batch containing each input document's text and metadata. Pass
                  this collection to a prompt or your host's batch tool.
                </Notice>
              )}
              {step.data.kind === "merge" && (
                <Notice>
                  Combines outputs from completed steps. A skipped conditional branch does not block
                  the join.
                </Notice>
              )}
              {step.data.kind === "response" && (
                <Notice>
                  Displays the latest prepared text or document in the run's output panel. This is
                  the end of a path.
                </Notice>
              )}
            </div>
            <div className="swf-field-section">
              <label className="swf-field">
                Output name
                <input
                  className="swf-mono"
                  value={step.data.output}
                  maxLength={48}
                  onChange={(e) => updateData({ output: e.target.value.replace(/\s/g, "_") })}
                />
                <small>A unique variable name for later steps.</small>
              </label>
            </div>
          </>
        ) : (
          <>
            <p className="swf-body-muted">
              Connect steps here, or drag between the circles on the canvas.
            </p>
            <h4>Incoming</h4>
            {flow.edges
              .filter((e) => e.target === step.id)
              .map((e) => (
                <div className="swf-connection" key={e.id}>
                  <button onClick={() => props.onSelect(e.source)}>
                    {flow.nodes.find((n) => n.id === e.source)?.data.label}
                    <small>{e.sourceHandle ? `${e.sourceHandle} branch` : "Step output"}</small>
                  </button>
                  <IconButton
                    icon="X"
                    label="Remove connection"
                    onClick={() => props.onDeleteEdge(e.id)}
                  />
                </div>
              ))}
            {!flow.edges.some((e) => e.target === step.id) && (
              <p className="swf-empty-inline">
                {step.data.kind === "trigger"
                  ? "This is the starting step."
                  : "No incoming connections."}
              </p>
            )}
            <h4>Outgoing</h4>
            {flow.edges
              .filter((e) => e.source === step.id)
              .map((e) => (
                <div className="swf-connection" key={e.id}>
                  <button onClick={() => props.onSelect(e.target)}>
                    {flow.nodes.find((n) => n.id === e.target)?.data.label}
                    <small>{e.sourceHandle ? `${e.sourceHandle} branch` : "Next step"}</small>
                  </button>
                  <IconButton
                    icon="X"
                    label="Remove connection"
                    onClick={() => props.onDeleteEdge(e.id)}
                  />
                </div>
              ))}
            {step.data.kind !== "response" && (
              <div className="swf-field-section">
                {step.data.kind === "condition" && (
                  <label className="swf-field">
                    Branch
                    <select
                      value={branch}
                      onChange={(e) => {
                        setBranch(e.target.value);
                        setTarget("");
                      }}
                    >
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </select>
                  </label>
                )}
                <label className="swf-field">
                  Next step
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Choose a step…</option>
                    {flow.nodes
                      .filter((n) =>
                        canConnect(
                          step.id,
                          n.id,
                          flow.nodes,
                          flow.edges,
                          step.data.kind === "condition" ? branch : undefined,
                        ),
                      )
                      .map((n) => (
                        <option value={n.id} key={n.id}>
                          {n.data.label}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  icon="Plus"
                  disabled={!target}
                  onClick={() => {
                    props.onConnect(
                      step.id,
                      target,
                      step.data.kind === "condition" ? branch : undefined,
                    );
                    setTarget("");
                  }}
                >
                  Connect step
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="swf-inspector-footer">
        <Button
          icon="Copy"
          variant="ghost"
          disabled={step.data.kind === "trigger"}
          onClick={props.onDuplicate}
        >
          Duplicate
        </Button>
        <IconButton
          icon="Trash2"
          label="Delete step"
          disabled={step.data.kind === "trigger"}
          className="swf-danger-text"
          onClick={props.onDelete}
        />
      </div>
    </aside>
  );
}
