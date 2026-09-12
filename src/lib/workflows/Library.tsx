import { useRef, useState } from "react";
import { templates } from "./seeds";
import { appTemplates } from "./app-templates";
import { firmRoles, litigationStages } from "./practice-templates";
import { TemplateGuide } from "./TemplateGuide";
import { Badge, Button, Icon, IconButton, Tile, timeLabel, statusTone } from "./ui";
import type { Workflow, WorkflowRun } from "./types";

type Props = {
  flows: Workflow[];
  runs: WorkflowRun[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onTemplate: (id: string) => void;
  onImport: (file: File) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRun: (flow: Workflow) => void;
  onViewRun: (id: string) => void;
  onApp: (id: string) => void;
  onOpenApp: (id: string) => void;
  onAbout: () => void;
};
export function Library(props: Props) {
  const [tab, setTab] = useState<"apps" | "workflows" | "templates" | "runs">("apps"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const importRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState("All categories");
  const [role, setRole] = useState("All roles");
  const [stage, setStage] = useState("All stages");
  const apps = appTemplates.filter(
    (t) =>
      (category === "All categories" || t.category === category) &&
      (role === "All roles" || t.guide?.roles.includes(role)) &&
      (stage === "All stages" || t.guide?.stage === stage) &&
      [t.name, t.description, t.category, t.input, t.output, ...(t.guide?.roles || [])]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const flows = props.flows.filter(
    (f) =>
      `${f.name} ${f.description} ${f.category}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "published" && f.publishedAt) ||
        (filter === "private" && f.sharing.visibility === "private") ||
        (filter === "shared" && f.sharing.visibility === "teams")),
  );
  const filteredTemplates = templates.filter((t) =>
    `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="swf-library">
      <div className="swf-library-inner">
        <div className="swf-library-heading">
          <div>
            <h1>Workflows</h1>
            <p>Build repeatable legal processes. Run them as simple apps.</p>
          </div>
          <div className="swf-inline">
            <IconButton icon="Info" label="Workspace information" onClick={props.onAbout} />
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onImport(f);
                e.target.value = "";
              }}
            />
            <Button icon="Upload" onClick={() => importRef.current?.click()}>
              Import
            </Button>
            <Button variant="primary" icon="Plus" onClick={props.onNew}>
              New workflow
            </Button>
          </div>
        </div>
        <div className="swf-library-tabs">
          <div role="tablist" aria-label="Workflow library">
            <button
              role="tab"
              aria-selected={tab === "apps"}
              className={tab === "apps" ? "active" : ""}
              onClick={() => setTab("apps")}
            >
              <Icon name="LayoutGrid" />
              Mini apps <span>{appTemplates.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === "workflows"}
              className={tab === "workflows" ? "active" : ""}
              onClick={() => setTab("workflows")}
            >
              <Icon name="FolderOpen" />
              My workflows <span>{props.flows.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === "templates"}
              className={tab === "templates" ? "active" : ""}
              onClick={() => setTab("templates")}
            >
              <Icon name="LayoutGrid" />
              Templates
            </button>
            <button
              role="tab"
              aria-selected={tab === "runs"}
              className={tab === "runs" ? "active" : ""}
              onClick={() => setTab("runs")}
            >
              <Icon name="History" />
              Run history <span>{props.runs.length}</span>
            </button>
          </div>
          <span className="swf-small-meta">
            <Icon name="LockKeyhole" size={13} /> Saved to your workspace
          </span>
        </div>
        <div className="swf-library-filters">
          <div className="swf-search">
            <Icon name="Search" />
            <input
              placeholder={
                tab === "templates" || tab === "apps"
                  ? "Find a template or use case…"
                  : "Search workflows…"
              }
              aria-label="Search workflows"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {tab === "workflows" && (
            <div className="swf-filter-chips">
              {[
                { key: "all", label: "All workflows" },
                { key: "private", label: "Private" },
                { key: "shared", label: "Shared with teams" },
                { key: "published", label: "Published" },
              ].map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={filter === f.key ? "active" : ""}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {tab === "templates" && (
            <span className="swf-body-muted">
              {filteredTemplates.length + apps.length} legal workflow templates
            </span>
          )}
          {["apps", "templates"].includes(tab) && (
            <select
              className="swf-category-filter"
              aria-label="Template category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {["All categories", ...new Set(appTemplates.map((t) => t.category))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </div>
        {["apps", "templates"].includes(tab) && (
          <div className="swf-role-filters">
            <label>
              <Icon name="Users" size={14} />
              <span>For your role</span>
              <select aria-label="Firm role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option>All roles</option>
                {firmRoles.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Litigation stage</span>
              <select
                aria-label="Litigation stage"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option>All stages</option>
                {litigationStages.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <span>{apps.length} matching apps</span>
            {(role !== "All roles" ||
              stage !== "All stages" ||
              category !== "All categories" ||
              query) && (
              <button
                className="swf-text-button"
                onClick={() => {
                  setRole("All roles");
                  setStage("All stages");
                  setCategory("All categories");
                  setQuery("");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        {tab === "apps" && (
          <>
            <div className="swf-app-library-intro">
              <div>
                <h2>Ready-to-use mini apps</h2>
                <p>
                  Practical tools for intake, discovery, docketing, trial and settlement. Choose a
                  template, then adapt the workflow to your matter.
                </p>
              </div>
              <Badge tone="green">{appTemplates.length} ready-to-adapt apps</Badge>
            </div>
            {props.flows.some((f) => f.app) && (
              <div className="swf-saved-apps">
                <h3>Your saved apps</h3>
                <div>
                  {props.flows
                    .filter((f) => f.app)
                    .map((f) => (
                      <Button key={f.id} icon="Play" onClick={() => props.onOpenApp(f.id)}>
                        {f.name}
                      </Button>
                    ))}
                </div>
              </div>
            )}
            <div className="swf-app-template-grid">
              {apps.map((t) => (
                <AppCard
                  key={t.id}
                  t={t}
                  selectedRole={role}
                  onUse={() => props.onApp(t.id)}
                  onBuild={() => props.onTemplate(t.id)}
                />
              ))}
            </div>
            {!apps.length && <div className="swf-empty">No apps match this search.</div>}
          </>
        )}
        {tab === "workflows" && (
          <>
            <div className="swf-workflow-table">
              <div className="swf-workflow-table-head">
                <span>Workflow</span>
                <span>Status</span>
                <span>Access</span>
                <span>Last edited</span>
                <span />
              </div>
              {flows.map((f) => (
                <div className="swf-workflow-row" key={f.id}>
                  <button className="swf-workflow-name" onClick={() => props.onOpen(f.id)}>
                    <Tile
                      icon={
                        f.nodes.some((n) => n.data.kind === "condition")
                          ? "GitBranch"
                          : f.category === "Knowledge"
                            ? "NotebookText"
                            : "Files"
                      }
                      tone={
                        f.category === "Knowledge"
                          ? "amber"
                          : f.nodes.some((n) => n.data.kind === "condition")
                            ? "purple"
                            : "blue"
                      }
                    />
                    <div>
                      <strong>{f.name}</strong>
                      <span>
                        {f.nodes.length} steps <i>·</i> {f.category}
                      </span>
                    </div>
                  </button>
                  <div>
                    <Badge tone={f.publishedAt && !f.dirty ? "green" : "slate"}>
                      {f.publishedAt
                        ? f.dirty
                          ? "Unpublished edits"
                          : `Published · v${f.version}`
                        : "Draft"}
                    </Badge>
                    {f.schedule.enabled && (
                      <span className="swf-row-sub">
                        <Icon name="CalendarClock" size={12} />
                        Scheduled
                      </span>
                    )}
                  </div>
                  <span className="swf-access">
                    <Icon
                      name={f.sharing.visibility === "teams" ? "Users" : "LockKeyhole"}
                      size={14}
                    />
                    {f.sharing.visibility === "teams" ? f.sharing.teams[0] || "Teams" : "Only you"}
                  </span>
                  <span className="swf-date">{timeLabel(f.updatedAt)}</span>
                  <div className="swf-row-actions">
                    <IconButton
                      icon="Play"
                      label={`Run ${f.name}`}
                      onClick={() => props.onRun(f)}
                    />
                    <details className="swf-row-menu">
                      <summary aria-label={`Actions for ${f.name}`}>
                        <Icon name="MoreHorizontal" />
                      </summary>
                      <div>
                        <button onClick={() => props.onOpen(f.id)}>
                          <Icon name="Settings2" />
                          Open builder
                        </button>
                        <button onClick={() => props.onOpenApp(f.id)}>
                          <Icon name="LayoutGrid" />
                          Open mini app
                        </button>
                        <button onClick={() => props.onDuplicate(f.id)}>
                          <Icon name="Copy" />
                          Duplicate
                        </button>
                        <button className="swf-danger-text" onClick={() => props.onDelete(f.id)}>
                          <Icon name="Trash2" />
                          Delete workflow
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              ))}
              {!flows.length && (
                <div className="swf-empty">
                  <Icon name="Search" size={25} />
                  <h3>No workflows found</h3>
                  <p>Try another search, or create your first workflow.</p>
                  <Button onClick={props.onNew} icon="Plus">
                    New workflow
                  </Button>
                </div>
              )}
            </div>
            <div className="swf-section-heading">
              <div>
                <h2>A useful place to start</h2>
                <p>Adapt a proven structure to your team's way of working.</p>
              </div>
              <button
                className="swf-text-button"
                onClick={() => {
                  setTab("templates");
                  setQuery("");
                }}
              >
                Explore all templates <Icon name="ArrowRight" size={15} />
              </button>
            </div>
            <div className="swf-template-grid">
              {templates.slice(0, 3).map((t) => (
                <TemplateCard key={t.id} template={t} onUse={() => props.onTemplate(t.id)} />
              ))}
            </div>
            <div className="swf-library-note">
              <Icon name="ShieldCheck" size={17} />
              <p>
                <strong>Designed for legal work.</strong> Build in source references, review
                checkpoints, and clear handoffs from the start.
              </p>
              <span>25 building blocks</span>
            </div>
          </>
        )}
        {tab === "templates" && (
          <>
            <div className="swf-app-template-grid">
              {apps.map((t) => (
                <AppCard
                  key={t.id}
                  t={t}
                  selectedRole={role}
                  onUse={() => props.onApp(t.id)}
                  onBuild={() => props.onTemplate(t.id)}
                />
              ))}
            </div>
            <div className="swf-section-heading">
              <h3>Foundational workflow patterns</h3>
            </div>
            <div className="swf-template-grid swf-template-full">
              {filteredTemplates.map((t) => (
                <TemplateCard key={t.id} template={t} onUse={() => props.onTemplate(t.id)} />
              ))}
              {!filteredTemplates.length && (
                <p className="swf-body-muted">No templates match your search.</p>
              )}
            </div>
          </>
        )}
        {tab === "runs" && (
          <RunHistory
            runs={props.runs.filter((r) =>
              r.workflowName.toLowerCase().includes(query.toLowerCase()),
            )}
            onView={props.onViewRun}
          />
        )}
      </div>
      <footer className="swf-library-footer">
        <span>WORKFLOWS STUDIO</span>
        <span>Build · review · repeat</span>
      </footer>
    </main>
  );
}
function AppCard({
  t,
  selectedRole,
  onUse,
  onBuild,
}: {
  t: (typeof appTemplates)[number];
  selectedRole: string;
  onUse: () => void;
  onBuild: () => void;
}) {
  const roles = t.guide?.roles || [];
  const visibleRoles =
    selectedRole !== "All roles" && roles.includes(selectedRole)
      ? [selectedRole, ...roles.filter((r) => r !== selectedRole)]
      : roles;
  return (
    <article className="swf-app-template-card">
      <div className="swf-inline">
        <Tile icon={t.icon} tone={t.tone} />
        <span>{t.category}</span>
        <Badge tone={t.mode === "Local" ? "green" : "blue"}>
          {t.mode === "Local" ? "Document analysis" : t.mode}
        </Badge>
      </div>
      <h3>{t.name}</h3>
      <p>{t.description}</p>
      <div className="swf-app-role-line" title={roles.join(" · ")}>
        {visibleRoles.slice(0, 2).join(" · ")}
        {roles.length > 2 ? ` · +${roles.length - 2}` : ""}
      </div>
      <dl>
        <dt>Input</dt>
        <dd>{t.input}</dd>
        <dt>Output</dt>
        <dd>{t.output}</dd>
      </dl>
      <div className="swf-app-card-actions">
        <Button icon="Play" onClick={onUse}>
          Use mini app
        </Button>
        <Button variant="ghost" icon="WorkflowIcon" onClick={onBuild}>
          Builder
        </Button>
      </div>
      <TemplateGuide template={t} onUse={onUse} onBuild={onBuild} />
    </article>
  );
}
function TemplateCard({
  template: t,
  onUse,
}: {
  template: (typeof templates)[number];
  onUse: () => void;
}) {
  return (
    <button className="swf-template-card" onClick={onUse}>
      <div className="swf-template-top">
        <Tile icon={t.icon} tone={t.tone} />
        <span>{t.category}</span>
        <Icon name="ArrowRight" />
      </div>
      <h3>{t.name}</h3>
      <p>{t.description}</p>
      <div className="swf-template-footer">
        <span>
          <Icon name="WorkflowIcon" size={13} />
          {t.kinds.length} steps
        </span>
        <span>{t.outcome}</span>
      </div>
    </button>
  );
}
export function RunHistory({
  runs,
  onView,
}: {
  runs: WorkflowRun[];
  onView: (id: string) => void;
}) {
  return (
    <div className="swf-run-history">
      {runs.length ? (
        <>
          <div className="swf-history-head">
            <span>Workflow run</span>
            <span>Status</span>
            <span>Started</span>
            <span>Outputs</span>
          </div>
          {runs.map((r) => (
            <button className="swf-history-row" key={r.id} onClick={() => onView(r.id)}>
              <div>
                <strong>{r.workflowName}</strong>
                <small>
                  {r.source === "schedule" ? "Scheduled" : "Manual test"} ·{" "}
                  {r.mode === "local" ? "Server run" : "Server run"} · {r.id.slice(0, 8)}
                </small>
              </div>
              <span>
                <Badge tone={statusTone(r.status)}>
                  {r.status === "waiting" ? "Needs attention" : r.status}
                </Badge>
              </span>
              <span className="swf-date">{timeLabel(r.startedAt)}</span>
              <span>
                {r.artifacts.length} files <Icon name="ChevronRight" size={14} />
              </span>
            </button>
          ))}
        </>
      ) : (
        <div className="swf-empty">
          <Tile icon="History" tone="blue" />
          <h3>Your process, step by step</h3>
          <p>Test a workflow to see its decisions, review checkpoints, and generated files here.</p>
        </div>
      )}
    </div>
  );
}
