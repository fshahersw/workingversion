import { useEffect, useRef, useState } from "react";
import { appTemplates } from "./app-templates";
import { readSourceBatch } from "./files";
import { isAnalysisReport } from "./recipes";
import { FolderInput, VoiceInput } from "./IntakeTools";
import { ReportView } from "./ReportView";
import { TemplateGuide } from "./TemplateGuide";
import { SourcePicker } from "./SourcePicker";
import { Badge, Button, Icon, Notice } from "./ui";
import type {
  AppField,
  MiniAppSpec,
  RunInputs,
  SourceFile,
  Workflow,
  WorkflowAdapter,
  WorkflowRun,
} from "./types";
const emptyInputs = (flow: Workflow): RunInputs => ({
  matter: "",
  text: "",
  selection:
    flow.nodes.find((n) => n.data.kind === "selection")?.data.config.options?.[0] || "Standard",
  files: [],
  fields: Object.fromEntries((flow.app?.fields || []).map((f) => [f.id, f.value || ""])),
});
export function AppStudio({
  flow,
  runs,
  onRun,
  onShowRun,
  onEdit,
  adapter,
}: {
  flow: Workflow;
  runs: WorkflowRun[];
  onRun: (inputs: RunInputs) => Promise<string>;
  onShowRun: (id: string) => void;
  onEdit: () => void;
  adapter?: WorkflowAdapter;
}) {
  const [inputs, setInputs] = useState(() => emptyInputs(flow)),
    [error, setError] = useState(""),
    [reading, setReading] = useState(false),
    [runId, setRunId] = useState<string>(),
    [auto, setAuto] = useState(flow.app?.autoRunOnUpload || false);
  const [launching, setLaunching] = useState(false);
  const [coverageReviewed, setCoverageReviewed] = useState(false);
  const extractionWarnings = inputs.files.flatMap((f) =>
    (f.metadata?.warnings || []).map((w) => `${f.name}: ${w}`),
  );
  const inputRef = useRef<HTMLInputElement>(null),
    busyRef = useRef(false),
    mounted = useRef(true);
  const t = appTemplates.find((t) => t.id === flow.app?.templateId),
    run = runs.find((r) => r.id === runId);
  const busy = launching || reading || (!!run && ["running", "waiting"].includes(run.status));
  busyRef.current = busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const report = run
    ? Object.values(run.results)
        .map((r) => r.output)
        .find(isAnalysisReport)
    : undefined;
  const launch = async (next: RunInputs) => {
    setLaunching(true);
    try {
      if (next.files.some((f) => f.metadata?.warnings.length) && !coverageReviewed)
        throw new Error(
          "Review and acknowledge the extraction warnings before running. Image-only content may need OCR.",
        );
      for (const f of flow.app?.fields || [])
        if (f.required && !next.fields?.[f.id]?.trim()) throw new Error("Enter " + f.label + ".");
      if (
        !next.files.length &&
        !next.text.trim() &&
        !flow.nodes.some((n) => ["web", "scrape"].includes(n.data.kind))
      )
        throw new Error("Upload a file or enter source text first.");
      const id = await onRun({
        ...next,
        fields: { ...next.fields, coverageAcknowledged: String(coverageReviewed) },
      });
      setRunId(id);
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start this app.");
      return false;
    } finally {
      setLaunching(false);
    }
  };
  const upload = async (files: File[]) => {
    if (busyRef.current) return;
    setReading(true);
    setError("");
    try {
      if (files.length > 20) throw new Error("Choose up to 20 files at a time.");
      const parsed = await readSourceBatch(files);
      if (!mounted.current) return;
      setCoverageReviewed(false);
      const next = { ...inputs, files: parsed, text: "" };
      setInputs(next);
      if (auto && !parsed.some((f) => f.metadata?.warnings.length)) launch(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not read that file.";
      setError(msg);
      throw e;
    } finally {
      if (mounted.current) setReading(false);
    }
  };
  const latestOutput = run?.graph.nodes
    .filter((n) => run.results[n.id]?.status === "completed")
    .map((n) => run.results[n.id].output)
    .reverse()
    .find((v) => v && typeof v === "object" && "text" in v) as { text: string } | undefined;
  return (
    <section className="swf-miniapp">
      <aside className="swf-app-inputs">
        <div className="swf-eyebrow">
          <Icon name={t?.icon || "LayoutGrid"} size={14} />
          RUN AS A MINI APP
        </div>
        <h2>{flow.name}</h2>
        <p>{flow.app?.description || flow.description}</p>
        <div className="swf-app-mode">
          <Badge
            tone={
              t?.mode === "Web connection" ||
              flow.nodes.some((n) => n.data.config.model === "bedrock")
                ? "blue"
                : "green"
            }
          >
            {flow.nodes.some((n) => n.data.config.model === "bedrock")
              ? "Bedrock analysis"
              : t?.mode === "Web connection"
                ? "Public web tools"
                : "Document checks"}
          </Badge>
          <span>{t?.output || "Workflow results"}</span>
        </div>
        {t && <TemplateGuide template={t} />}
        <SourcePicker
          busy={busy}
          onFiles={(files) => {
            setInputs({ ...inputs, files, text: "" });
            setCoverageReviewed(false);
          }}
        />
        <label className="swf-field">
          Matter / project
          <input
            value={inputs.matter}
            placeholder="Optional matter name"
            onChange={(e) => setInputs({ ...inputs, matter: e.target.value })}
            disabled={busy}
          />
        </label>
        {(flow.app?.fields || []).map((f) => (
          <label className="swf-field" key={f.id}>
            {f.label}
            {f.required ? " *" : ""}
            {f.type === "textarea" ? (
              <textarea
                rows={3}
                value={inputs.fields?.[f.id] || ""}
                disabled={busy}
                onChange={(e) =>
                  setInputs({
                    ...inputs,
                    fields: { ...inputs.fields, [f.id]: e.target.value },
                  })
                }
              />
            ) : f.type === "select" ? (
              <select
                value={inputs.fields?.[f.id] || ""}
                disabled={busy}
                onChange={(e) =>
                  setInputs({
                    ...inputs,
                    fields: { ...inputs.fields, [f.id]: e.target.value },
                  })
                }
              >
                {!f.value && <option value="">Choose…</option>}
                {(f.options || []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={f.type}
                value={inputs.fields?.[f.id] || ""}
                disabled={busy}
                onChange={(e) =>
                  setInputs({
                    ...inputs,
                    fields: { ...inputs.fields, [f.id]: e.target.value },
                  })
                }
              />
            )}
          </label>
        ))}
        {flow.nodes.some((n) => n.data.kind === "selection") && (
          <label className="swf-field">
            Workflow choice
            <select
              value={inputs.selection}
              disabled={busy}
              onChange={(e) => setInputs({ ...inputs, selection: e.target.value })}
            >
              {[
                ...new Set(
                  flow.nodes
                    .filter((n) => n.data.kind === "selection")
                    .flatMap((n) => n.data.config.options || []),
                ),
              ].map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          </label>
        )}
        {!flow.nodes.some((n) => ["web", "scrape"].includes(n.data.kind)) && (
          <>
            <button
              className="swf-drop-area"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) void upload(Array.from(e.dataTransfer.files)).catch(() => {});
              }}
            >
              <Icon name={reading ? "Loader2" : "FileUp"} size={25} />
              <strong>{reading ? "Reading source files…" : "Drop files here or browse"}</strong>
              <span>PDF · DOCX · EML · TXT · CSV / TSV · JSON</span>
              <small>20 files · 20 MB each · text PDFs up to 300 pages</small>
            </button>
            <input
              hidden
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.eml,.txt,.md,.csv,.tsv,.json"
              onChange={(e) => {
                if (e.target.files) void upload(Array.from(e.target.files)).catch(() => {});
                e.target.value = "";
              }}
            />
            {inputs.files.length > 0 && (
              <div className="swf-uploaded-list">
                {inputs.files.map((f) => (
                  <div key={f.id}>
                    <Icon name="FileText" size={13} />
                    <span title={f.name}>{f.name}</span>
                    <small>{f.text.length.toLocaleString()} chars</small>
                    <button
                      aria-label={"Remove " + f.name}
                      disabled={busy}
                      onClick={() =>
                        setInputs({
                          ...inputs,
                          files: inputs.files.filter((x) => x.id !== f.id),
                        })
                      }
                    >
                      <Icon name="X" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {extractionWarnings.length > 0 && (
              <div className="swf-source-warnings" role="status">
                <strong>Review document coverage</strong>
                {extractionWarnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={coverageReviewed}
                    onChange={(e) => setCoverageReviewed(e.target.checked)}
                    disabled={busy}
                  />
                  I reviewed these extraction warnings
                </label>
              </div>
            )}
            <label className="swf-inline swf-auto-toggle">
              <input
                type="checkbox"
                checked={auto}
                disabled={busy}
                onChange={(e) => setAuto(e.target.checked)}
              />
              Run automatically after an upload
            </label>
            <label className="swf-field">
              Or paste source text
              <textarea
                rows={5}
                placeholder="Paste a transcript, draft, or email…"
                disabled={busy}
                value={inputs.text}
                onChange={(e) => setInputs({ ...inputs, text: e.target.value, files: [] })}
              />
            </label>
            <details className="swf-intake-options">
              <summary>Voice & folder intake</summary>
              <VoiceInput
                onText={(text) =>
                  setInputs((old) => ({
                    ...old,
                    text: (old.text + " " + text).trim(),
                    files: [],
                  }))
                }
              />
              <FolderInput busy={busy} onFiles={upload} />
            </details>
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          className="swf-run-app-button"
          variant="primary"
          icon={busy ? "Loader2" : "Play"}
          disabled={busy}
          onClick={() => launch(inputs)}
        >
          {busy ? "Working…" : "Run app"}
        </Button>
        <small className="swf-app-local-note">
          {t?.mode === "Web connection"
            ? "Only the query or URL is sent to the web service."
            : "Runs use your platform’s private storage and approved server services."}
        </small>
        <button className="swf-text-button" onClick={onEdit}>
          <Icon name="Settings2" size={14} />
          Customize this app's form
        </button>
      </aside>
      <div className="swf-app-results">
        {run && (
          <div className="swf-app-run-strip">
            <Badge
              tone={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "blue"}
            >
              {run.status}
            </Badge>
            <span>
              {run.graph.nodes.filter((n) => run.results[n.id]?.status === "completed").length} /{" "}
              {run.graph.nodes.length} steps
            </span>
            <Button variant="ghost" icon="History" onClick={() => onShowRun(run.id)}>
              Activity & controls
            </Button>
          </div>
        )}
        {run?.status === "failed" && (
          <Notice tone="error">
            {run.logs.filter((l) => l.level === "error").at(-1)?.message ||
              "This run failed. Review the activity log."}
          </Notice>
        )}
        {run?.status === "waiting" && (
          <Notice>
            This run is waiting for review or a timed step. Open Activity & controls to continue.
          </Notice>
        )}
        {report ? (
          <ReportView key={runId} report={report} artifacts={run?.artifacts || []} />
        ) : latestOutput ? (
          <pre className="swf-report-draft">{latestOutput.text}</pre>
        ) : (
          <div className="swf-app-results-empty">
            <div className="swf-result-illustration">
              <Icon name="Table2" size={36} />
              <span />
              <span />
              <span />
            </div>
            <h2>A useful result starts with your sources</h2>
            <p>
              {t?.input || "Add your source material"}, then run the app. Findings will appear here
              with excerpts you can inspect.
            </p>
            <div>
              <span>
                <Icon name="FileCheck2" />
                Traceable findings
              </span>
              <span>
                <Icon name="Download" />
                Word & CSV exports
              </span>
              <span>
                <Icon name="UserRoundCheck" />
                Human review
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
export function AppFormEditor({
  flow,
  onChange,
}: {
  flow: Workflow;
  onChange: (app: MiniAppSpec) => void;
}) {
  const spec = flow.app || {
    description: flow.description,
    autoRunOnUpload: false,
    fields: [],
  };
  const update = (field: AppField) =>
    onChange({
      ...spec,
      fields: spec.fields.map((f) => (f.id === field.id ? field : f)),
    });
  return (
    <div className="swf-form-editor">
      <div>
        <Badge tone="green">Custom mini app</Badge>
        <h2>Give your workflow a simple front end</h2>
        <p>Choose the information users provide. Run the same workflow behind a focused form.</p>
        <label className="swf-field">
          Instructions for users
          <textarea
            rows={3}
            value={spec.description}
            onChange={(e) => onChange({ ...spec, description: e.target.value })}
          />
        </label>
        <label className="swf-inline">
          <input
            type="checkbox"
            checked={spec.autoRunOnUpload}
            onChange={(e) => onChange({ ...spec, autoRunOnUpload: e.target.checked })}
          />
          Run automatically after users upload files
        </label>
        <div className="swf-section-heading">
          <h3>Custom input fields</h3>
          <Button
            icon="Plus"
            disabled={spec.fields.length >= 12}
            onClick={() =>
              onChange({
                ...spec,
                fields: [
                  ...spec.fields,
                  {
                    id: "field_" + crypto.randomUUID().slice(0, 8),
                    label: "New field",
                    type: "text",
                    required: false,
                  },
                ],
              })
            }
          >
            Add field
          </Button>
        </div>
        {spec.fields.map((f, i) => (
          <div className="swf-form-field-row" key={f.id}>
            <div className="swf-inline">
              <Icon name="GripVertical" />
              <strong>Field {i + 1}</strong>
              <code>{"input.fields." + f.id}</code>
              <Button
                variant="ghost"
                icon="ArrowUp"
                disabled={!i}
                onClick={() => {
                  const fields = [...spec.fields];
                  [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
                  onChange({ ...spec, fields });
                }}
              >
                Move up
              </Button>
              <Button
                variant="ghost"
                icon="Trash2"
                onClick={() =>
                  onChange({
                    ...spec,
                    fields: spec.fields.filter((x) => x.id !== f.id),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <div className="swf-form-grid">
              <label className="swf-field">
                Label
                <input
                  maxLength={100}
                  value={f.label}
                  onChange={(e) => update({ ...f, label: e.target.value })}
                />
              </label>
              <label className="swf-field">
                Input type
                <select
                  value={f.type}
                  onChange={(e) => update({ ...f, type: e.target.value as AppField["type"] })}
                >
                  <option value="text">Short text</option>
                  <option value="textarea">Long text</option>
                  <option value="select">Selection</option>
                  <option value="date">Date</option>
                  <option value="url">URL</option>
                </select>
              </label>
              <label className="swf-field">
                Default value
                <input
                  value={f.value || ""}
                  onChange={(e) => update({ ...f, value: e.target.value })}
                />
              </label>
              <label className="swf-inline">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => update({ ...f, required: e.target.checked })}
                />
                Required
              </label>
            </div>
            {f.type === "select" && (
              <label className="swf-field">
                Options (one per line)
                <textarea
                  value={(f.options || []).join("\n")}
                  onChange={(e) =>
                    update({
                      ...f,
                      options: e.target.value.split("\n").slice(0, 30),
                    })
                  }
                />
              </label>
            )}
          </div>
        ))}
        {!spec.fields.length && (
          <Notice>
            File upload and source text are always available. Add fields for a matter-specific
            question, issue list or output preference.
          </Notice>
        )}
        <Notice>
          Use the field references shown above in prompt steps, wrapped in double braces. Local
          recipes use their predefined fields; custom questions can be passed to a connected AI
          step.
        </Notice>
      </div>
      <aside>
        <Icon name="LayoutGrid" size={32} />
        <h3>One workflow. Two ways to use it.</h3>
        <p>
          The builder defines the process. The mini app collects inputs and presents results, so
          your colleagues can run it without editing the graph.
        </p>
        <p>
          Form settings travel with your exported workflow. Team access is enforced by your host
          platform.
        </p>
      </aside>
    </div>
  );
}
