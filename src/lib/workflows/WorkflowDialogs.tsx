import { useMemo, useState } from "react";
import { templates } from "./seeds";
import { nextScheduledRun, scheduleDescription } from "./schedule";
import { Badge, Button, Icon, Modal, Notice, Tile } from "./ui";
import type { WorkflowRun, Schedule, Sharing, Workflow } from "./types";

export function NewWorkflowDialog({
  onClose,
  onCreate,
  onTemplate,
}: {
  onClose: () => void;
  onCreate: (name: string, description?: string) => void;
  onTemplate: (id: string) => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  return (
    <Modal
      title="Create a workflow"
      description="Start with a process you know, then make it your own."
      onClose={onClose}
      wide
    >
      <div className="swf-new-dialog">
        <div className="swf-new-form">
          <label className="swf-field">
            Workflow name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly discovery review"
              maxLength={100}
            />
          </label>
          <label className="swf-field">
            Describe the process <span className="swf-optional">optional</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Read the production files, identify sensitive material, ask an attorney to review, then create a summary…"
              maxLength={3000}
            />
            <small>
              The local starter builder chooses a template from your description. You can edit every
              step.
            </small>
          </label>
          <Button
            variant="primary"
            icon={description.trim() ? "WandSparkles" : "Plus"}
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim(), description.trim())}
          >
            {description.trim() ? "Create from description" : "Create blank workflow"}
          </Button>
        </div>
        <div className="swf-new-templates">
          <h4>Or use a template</h4>
          {templates.slice(0, 4).map((t) => (
            <button key={t.id} onClick={() => onTemplate(t.id)}>
              <Tile icon={t.icon} tone={t.tone} small />
              <span>
                <strong>{t.name}</strong>
                <small>
                  {t.kinds.length} steps · {t.category}
                </small>
              </span>
              <Icon name="ChevronRight" size={15} />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
export function ShareDialog({
  groups,
  flow,
  connected,
  onSave,
  onCopyLink,
  onExport,
  onClose,
}: {
  flow: Workflow;
  connected: boolean;
  onSave: (sharing: Sharing) => Promise<void>;
  groups: string[];
  onCopyLink: () => Promise<void>;
  onExport: () => void;
  onClose: () => void;
}) {
  const [sharing, setSharing] = useState<Sharing>(structuredClone(flow.sharing));
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  return (
    <Modal title="Share workflow" description={flow.name} onClose={onClose}>
      <div className="swf-modal-body">
        <div className="swf-share-owner">
          <span className="swf-avatar">{flow.createdBy.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{flow.createdBy}</strong>
            <small>Workflow owner</small>
          </div>
          <Badge>Owner</Badge>
        </div>
        <label className="swf-field">
          Who can access
          <select
            value={sharing.visibility}
            onChange={(e) =>
              setSharing({
                ...sharing,
                visibility: e.target.value as Sharing["visibility"],
              })
            }
          >
            <option value="private">Only me</option>
            <option value="teams">Selected teams</option>
          </select>
        </label>
        {sharing.visibility === "teams" && (
          <>
            <div className="swf-team-options">
              {groups.map((team) => (
                <label key={team}>
                  <input
                    type="checkbox"
                    checked={sharing.teams.includes(team)}
                    onChange={(e) =>
                      setSharing({
                        ...sharing,
                        teams: e.target.checked
                          ? [...sharing.teams, team]
                          : sharing.teams.filter((t) => t !== team),
                      })
                    }
                  />
                  <Icon name="Users" />
                  <span>{team}</span>
                </label>
              ))}
            </div>
            <label className="swf-field">
              Team permission
              <select
                value={sharing.permission}
                onChange={(e) =>
                  setSharing({
                    ...sharing,
                    permission: e.target.value as Sharing["permission"],
                  })
                }
              >
                <option value="view">Can view</option>
                <option value="run">Can view and run</option>
                <option value="edit">Can edit and run</option>
              </select>
            </label>
          </>
        )}
        <Notice>
          {connected
            ? "Access is checked against signed-in users and their Cognito groups. Sharing a definition does not share every user’s run documents."
            : "Workflow storage is unavailable."}
        </Notice>
        <div className="swf-field-section">
          <h4>Share or export</h4>
          <p className="swf-body-muted">
            Links require sign-in and existing access. JSON exports include only the workflow
            definition.
          </p>
          <div className="swf-inline">
            <Button
              icon={copied ? "Check" : "Copy"}
              onClick={async () => {
                try {
                  await onCopyLink();
                  setCopied(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not copy this link.");
                }
              }}
            >
              {copied ? "Link copied" : "Copy workflow link"}
            </Button>
            <Button icon="Download" onClick={onExport}>
              Export JSON
            </Button>
          </div>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <div className="swf-modal-footer">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          icon={pending ? "Loader2" : "Check"}
          disabled={pending || (sharing.visibility === "teams" && !sharing.teams.length)}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              await onSave(sharing);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Sharing settings could not be saved.");
            } finally {
              setPending(false);
            }
          }}
        >
          Save access settings
        </Button>
      </div>
    </Modal>
  );
}
export function ScheduleDialog({
  inputRuns,
  flow,
  connected,
  onSave,
  onClose,
}: {
  flow: Workflow;
  connected: boolean;
  inputRuns: WorkflowRun[];
  onSave: (schedule: Schedule) => Promise<void>;
  onClose: () => void;
}) {
  const [schedule, setSchedule] = useState<Schedule>(structuredClone(flow.schedule));
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const next = useMemo(() => {
    try {
      const next = nextScheduledRun(schedule);
      return { date: next, error: "" };
    } catch (e) {
      return {
        date: null,
        error: e instanceof Error ? e.message : "Check schedule settings.",
      };
    }
  }, [schedule]);
  const update = (patch: Partial<Schedule>) => setSchedule({ ...schedule, ...patch });
  return (
    <Modal
      title="Schedule workflow"
      description="Run a published version at a predictable time."
      onClose={onClose}
    >
      <div className="swf-modal-body">
        {schedule.lastError && (
          <Notice tone="error">
            Last scheduled attempt: {schedule.lastError}{" "}
            {schedule.lastErrorAt && new Date(schedule.lastErrorAt).toLocaleString()}
          </Notice>
        )}
        <div className="swf-schedule-enable">
          <div>
            <strong>Enable schedule</strong>
            <p>
              {flow.publishedAt
                ? `Runs published version ${flow.version}`
                : "Publish this workflow to enable scheduling."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={schedule.enabled}
            aria-label="Enable schedule"
            className={`swf-switch ${schedule.enabled ? "on" : ""}`}
            disabled={!flow.publishedAt || !connected}
            onClick={() => update({ enabled: !schedule.enabled })}
          >
            <span />
          </button>
        </div>
        <label className="swf-field">
          Source inputs
          <select
            value={schedule.inputRunId || ""}
            onChange={(e) => update({ inputRunId: e.target.value })}
          >
            <option value="">Choose a previous run…</option>
            {inputRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.startedAt).toLocaleString()} · {r.status}
              </option>
            ))}
          </select>
          <small>
            Reuses your selected run’s exact uploaded sources and form values. Web steps fetch fresh
            pages each time. Local folder access requires an open browser.
          </small>
        </label>
        <div className="swf-field-row">
          <label className="swf-field">
            Repeat
            <select
              value={schedule.frequency}
              onChange={(e) => update({ frequency: e.target.value as Schedule["frequency"] })}
            >
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
          <label className="swf-field">
            Time
            <input
              type="time"
              value={schedule.time}
              onChange={(e) => update({ time: e.target.value })}
            />
          </label>
        </div>
        {schedule.frequency === "weekly" && (
          <div className="swf-field">
            Days of the week
            <div className="swf-day-picker">
              {["S", "M", "T", "W", "T", "F", "S"].map((day, i) => (
                <button
                  key={i}
                  aria-label={
                    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
                      i
                    ]
                  }
                  aria-pressed={schedule.days.includes(i)}
                  className={schedule.days.includes(i) ? "active" : ""}
                  onClick={() =>
                    update({
                      days: schedule.days.includes(i)
                        ? schedule.days.filter((d) => d !== i)
                        : [...schedule.days, i].sort(),
                    })
                  }
                >
                  {day}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="swf-field">
          Time zone
          <select value={schedule.timezone} onChange={(e) => update({ timezone: e.target.value })}>
            {[
              "America/New_York",
              "America/Chicago",
              "America/Denver",
              "America/Los_Angeles",
              "Europe/London",
              "UTC",
            ].map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </select>
        </label>
        <div className="swf-schedule-summary">
          <Icon name="CalendarClock" size={20} />
          <div>
            <strong>{schedule.enabled ? scheduleDescription(schedule) : "Schedule is off"}</strong>
            <p>
              {next.date
                ? `Next run: ${new Date(next.date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: schedule.timezone })}`
                : "Turn on the schedule to see the next run."}
            </p>
          </div>
        </div>
        <Notice>
          {connected
            ? "Runs use the published version and the selected source inputs. Each scheduled occurrence has a durable, deduplicated run record."
            : "The workflow queue and scheduler must be configured before schedules can be enabled."}
        </Notice>
        {(error || next.error) && <Notice tone="error">{error || next.error}</Notice>}
      </div>
      <div className="swf-modal-footer">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          icon="Check"
          disabled={pending || !!next.error}
          onClick={async () => {
            setPending(true);
            try {
              await onSave({ ...schedule, nextRun: next.date || undefined });
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Schedule could not be saved.");
            } finally {
              setPending(false);
            }
          }}
        >
          Save schedule
        </Button>
      </div>
    </Modal>
  );
}
