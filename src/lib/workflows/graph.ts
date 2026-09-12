import { catalog } from "./catalog.ts";
import type { Workflow, WorkflowEdge, WorkflowStep, ValidationIssue } from "./types";

export function ancestors(
  id: string,
  nodes: WorkflowStep[],
  edges: WorkflowEdge[],
): WorkflowStep[] {
  const seen = new Set<string>();
  function visit(target: string) {
    for (const e of edges.filter((edge) => edge.target === target))
      if (!seen.has(e.source)) {
        seen.add(e.source);
        visit(e.source);
      }
  }
  visit(id);
  seen.delete(id);
  return nodes.filter((node) => seen.has(node.id));
}
export function canConnect(
  source: string,
  target: string,
  nodes: WorkflowStep[],
  edges: WorkflowEdge[],
  handle?: string | null,
): boolean {
  if (
    source === target ||
    !nodes.some((n) => n.id === source) ||
    !nodes.some((n) => n.id === target)
  )
    return false;
  const from = nodes.find((n) => n.id === source)!;
  const to = nodes.find((n) => n.id === target)!;
  if (to.data.kind === "trigger" || from.data.kind === "response") return false;
  if (
    edges.some(
      (e) =>
        e.source === source && e.target === target && (e.sourceHandle || "") === (handle || ""),
    )
  )
    return false;
  if (from.data.kind !== "condition" && handle) return false;
  if (
    from.data.kind === "condition" &&
    (!["true", "false"].includes(handle || "") ||
      edges.some((e) => e.source === source && e.sourceHandle === handle))
  )
    return false;
  return !ancestors(source, nodes, edges).some((n) => n.id === target);
}
export function validateWorkflow(flow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (message: string, nodeId?: string) =>
    issues.push({ severity: "error", message, nodeId });
  if (!flow.name.trim()) error("Give this workflow a name.");
  if (!flow.nodes.length) error("Add a start step and at least one action.");
  if (flow.nodes.length > 80 || flow.edges.length > 160)
    error("This editor supports up to 80 steps and 160 connections.");
  const starts = flow.nodes.filter((n) => n.data.kind === "trigger");
  if (starts.length !== 1) error("Use exactly one Start workflow step.");
  const ids = new Set<string>(),
    outputs = new Set<string>();
  for (const node of flow.nodes) {
    if (ids.has(node.id)) error("Step identifiers must be unique.", node.id);
    ids.add(node.id);
    if (!catalog.some((d) => d.kind === node.data.kind))
      error("This step type is not supported.", node.id);
    if (!node.data.label.trim()) error("Give this step a label.", node.id);
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(node.data.output) ||
      ["constructor", "prototype", "__proto__"].includes(node.data.output)
    )
      error(
        "Output names must start with a letter and contain only letters, numbers, or underscores (48 characters max).",
        node.id,
      );
    if (outputs.has(node.data.output))
      error(`The output name “${node.data.output}” is already used.`, node.id);
    outputs.add(node.data.output);
    if (node.data.kind !== "trigger" && !flow.edges.some((e) => e.target === node.id))
      error("Connect this step to an earlier step.", node.id);
    if (node.data.kind === "trigger" && flow.edges.some((e) => e.target === node.id))
      error("A start step cannot have incoming connections.", node.id);
    if (node.data.kind === "response" && flow.edges.some((e) => e.source === node.id))
      error("A response is an end step; remove its outgoing connection.", node.id);
    if (node.data.kind === "condition") {
      const outgoing = flow.edges.filter((e) => e.source === node.id);
      if (
        outgoing.filter((e) => e.sourceHandle === "true").length !== 1 ||
        outgoing.filter((e) => e.sourceHandle === "false").length !== 1 ||
        outgoing.length !== 2
      )
        error("Connect one True branch and one False branch.", node.id);
      if (!node.data.config.left?.trim()) error("Choose a value to evaluate.", node.id);
      if (!node.data.config.operator) error("Choose a condition operator.", node.id);
      const root = node.data.config.left
        ?.replace(/^\{\{|\}\}$/g, "")
        .trim()
        .split(".")[0];
      if (root && !ancestors(node.id, flow.nodes, flow.edges).some((n) => n.data.output === root))
        error(
          `The field “${node.data.config.left}” must reference an earlier step's output.`,
          node.id,
        );
    }
    if (["prompt", "agent"].includes(node.data.kind) && !node.data.config.instructions?.trim())
      error("Add instructions for this step.", node.id);
    if (node.data.kind === "extract" && !node.data.config.fields?.length)
      error("Add at least one field to extract.", node.id);
    if (node.data.kind === "selection" && !node.data.config.options?.length)
      error("Add at least one selection option.", node.id);
    if (node.data.kind === "table" && !node.data.config.fields?.filter((f) => f.trim()).length)
      error("Add at least one review column.", node.id);
    if (node.data.kind === "edit" && !node.data.config.left)
      error("Enter the text to replace.", node.id);
    for (const name of node.data.config.context || [])
      if (!ancestors(node.id, flow.nodes, flow.edges).some((n) => n.data.output === name))
        error(`Context “${name}” is not an output of an earlier step.`, node.id);
    if (
      node.data.kind === "delay" &&
      (!Number.isFinite(node.data.config.seconds) ||
        (node.data.config.seconds || 0) < 1 ||
        (node.data.config.seconds || 0) > 2592000)
    )
      error("Set a wait between one second and 30 days.", node.id);
    if (
      node.data.kind === "python" ||
      (node.data.kind === "mcp" && node.data.config.connection !== "workspace") ||
      (["prompt", "agent"].includes(node.data.kind) && node.data.config.model === "bedrock")
    )
      issues.push({
        severity: "warning",
        nodeId: node.id,
        message:
          "This step requires its configured server service. Review service availability before scheduling.",
      });
    if (
      starts.length === 1 &&
      node.id !== starts[0].id &&
      !ancestors(node.id, flow.nodes, flow.edges).some((n) => n.id === starts[0].id)
    )
      error("This step is not reachable from the start.", node.id);
  }
  const seenEdges = new Set<string>();
  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) error("A connection points to a missing step.");
    if (
      e.source === e.target ||
      ancestors(e.source, flow.nodes, flow.edges).some((n) => n.id === e.target)
    )
      error("Remove the circular connection. Workflows must move forward.", e.source);
    if (flow.nodes.find((n) => n.id === e.source)?.data.kind !== "condition" && e.sourceHandle)
      error("Only a condition step has named branch connections.", e.source);
    const key = `${e.source}:${e.sourceHandle || ""}:${e.target}`;
    if (seenEdges.has(key)) error("Remove the duplicate connection.", e.source);
    seenEdges.add(key);
  }
  return issues.filter(
    (issue, i, all) =>
      all.findIndex((other) => other.message === issue.message && other.nodeId === issue.nodeId) ===
      i,
  );
}
export function tidyLayout(nodes: WorkflowStep[], edges: WorkflowEdge[]): WorkflowStep[] {
  const levels = new Map<string, number>();
  const pending = [...nodes];
  for (let pass = 0; pass <= nodes.length && pending.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const incoming = edges.filter((e) => e.target === pending[i].id);
      if (incoming.every((e) => levels.has(e.source))) {
        levels.set(
          pending[i].id,
          incoming.length ? Math.max(...incoming.map((e) => levels.get(e.source)!)) + 1 : 0,
        );
        pending.splice(i, 1);
      }
    }
  }
  return nodes.map((n) => {
    const level = levels.get(n.id) || 0;
    const row = nodes.filter((other) => (levels.get(other.id) || 0) === level);
    const index = row.findIndex((other) => other.id === n.id);
    return {
      ...n,
      position: {
        x: 280 + (index - (row.length - 1) / 2) * 330,
        y: 20 + level * 145,
      },
    };
  });
}
export function exportWorkflow(flow: Workflow): string {
  return JSON.stringify(
    {
      ...flow,
      schedule: {
        ...flow.schedule,
        enabled: false,
        nextRun: undefined,
        lastRun: undefined,
      },
      publishedGraph: undefined,
      publishedAt: undefined,
      version: 0,
      dirty: true,
      sharing: { visibility: "private", teams: [], permission: "run" },
    },
    null,
    2,
  );
}
export function importWorkflow(text: string): Workflow {
  if (text.length > 500_000) throw new Error("Workflow files must be smaller than 500 KB.");
  const parsed = JSON.parse(text, (key, value) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("This file contains an unsupported object key.");
    return value;
  });
  if (
    parsed?.schemaVersion !== 1 ||
    typeof parsed.name !== "string" ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.edges) ||
    !parsed.schedule ||
    !parsed.sharing
  )
    throw new Error("Choose an exported Secretwise workflow (schema version 1).");
  if (parsed.nodes.length > 80 || parsed.edges.length > 160)
    throw new Error("This workflow exceeds the editor's size limit.");
  for (const n of parsed.nodes) {
    if (
      !n ||
      typeof n.id !== "string" ||
      n.id.length > 100 ||
      typeof n.data?.label !== "string" ||
      typeof n.data?.output !== "string" ||
      !catalog.some((d) => d.kind === n.data?.kind) ||
      !n.data.config ||
      typeof n.data.config !== "object" ||
      Array.isArray(n.data.config) ||
      !Number.isFinite(n.position?.x) ||
      !Number.isFinite(n.position?.y) ||
      Math.abs(n.position.x) > 100000 ||
      Math.abs(n.position.y) > 100000
    )
      throw new Error("The file contains an invalid step.");
    const config = n.data.config;
    for (const key of [
      "instructions",
      "model",
      "left",
      "operator",
      "right",
      "reviewer",
      "format",
      "filename",
      "value",
      "connection",
      "tool",
      "code",
      "query",
      "recipe",
      "url",
    ])
      if (
        config[key] !== undefined &&
        (typeof config[key] !== "string" || config[key].length > 20000)
      )
        throw new Error("A step contains invalid text settings.");
    for (const key of ["context", "fields", "options", "recipients"])
      if (
        config[key] !== undefined &&
        (!Array.isArray(config[key]) ||
          config[key].length > 100 ||
          config[key].some((value: unknown) => typeof value !== "string" || value.length > 500))
      )
        throw new Error("A step contains invalid list settings.");
    if (
      config.seconds !== undefined &&
      (typeof config.seconds !== "number" || !Number.isFinite(config.seconds))
    )
      throw new Error("A wait contains an invalid duration.");
    if (
      config.operator &&
      !["contains", "equals", "is_true", "greater_than", "exists"].includes(config.operator)
    )
      throw new Error("A condition contains an unsupported operator.");
    if (config.format && !["docx", "pdf", "txt", "csv"].includes(config.format))
      throw new Error("A document contains an unsupported format.");
    n.type = "step";
  }
  if (new Set(parsed.nodes.map((n: WorkflowStep) => n.id)).size !== parsed.nodes.length)
    throw new Error("Step identifiers must be unique.");
  for (const e of parsed.edges)
    if (
      !e ||
      typeof e.id !== "string" ||
      typeof e.source !== "string" ||
      typeof e.target !== "string" ||
      (e.label !== undefined && typeof e.label !== "string") ||
      (e.sourceHandle != null && !["true", "false"].includes(e.sourceHandle)) ||
      (e.targetHandle != null && e.targetHandle !== "")
    )
      throw new Error("The file contains an invalid connection.");
  if (new Set(parsed.edges.map((e: WorkflowEdge) => e.id)).size !== parsed.edges.length)
    throw new Error("Connection identifiers must be unique.");
  if (
    !["daily", "weekly"].includes(parsed.schedule.frequency) ||
    typeof parsed.schedule.time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.schedule.time) ||
    typeof parsed.schedule.timezone !== "string" ||
    !Array.isArray(parsed.schedule.days) ||
    parsed.schedule.days.some(
      (day: unknown) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6,
    )
  )
    throw new Error("The workflow contains invalid schedule settings.");
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: parsed.schedule.timezone,
    }).format();
  } catch {
    throw new Error("The workflow contains an invalid time zone.");
  }
  if (
    (parsed.category !== undefined && typeof parsed.category !== "string") ||
    (parsed.createdBy !== undefined && typeof parsed.createdBy !== "string")
  )
    throw new Error("The workflow contains invalid metadata.");
  if (parsed.app !== undefined) {
    const a = parsed.app;
    if (
      !a ||
      typeof a.description !== "string" ||
      a.description.length > 3000 ||
      typeof a.autoRunOnUpload !== "boolean" ||
      (a.templateId !== undefined && typeof a.templateId !== "string") ||
      !Array.isArray(a.fields) ||
      a.fields.length > 12
    )
      throw new Error("Invalid mini app settings.");
    const seen = new Set();
    for (const f of a.fields) {
      if (
        !f ||
        typeof f.id !== "string" ||
        !/^[a-zA-Z][\w]{0,40}$/.test(f.id) ||
        ["constructor", "prototype", "__proto__"].includes(f.id) ||
        seen.has(f.id) ||
        typeof f.label !== "string" ||
        f.label.length > 100 ||
        !["text", "textarea", "select", "date", "url"].includes(f.type) ||
        typeof f.required !== "boolean" ||
        (f.value !== undefined && (typeof f.value !== "string" || f.value.length > 20000)) ||
        (f.options !== undefined &&
          (!Array.isArray(f.options) ||
            f.options.length > 30 ||
            f.options.some((x: unknown) => typeof x !== "string" || x.length > 200)))
      )
        throw new Error("Invalid mini app field.");
      seen.add(f.id);
    }
  }
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: parsed.name.slice(0, 100),
    description: String(parsed.description || "").slice(0, 3000),
    category: parsed.category || "Litigation",
    ...(parsed.app ? { app: parsed.app } : {}),
    createdBy: parsed.createdBy || "Workflow owner",
    nodes: parsed.nodes.map((n: WorkflowStep) => ({
      id: n.id,
      type: "step",
      position: n.position,
      data: n.data,
    })),
    edges: parsed.edges.map((e: WorkflowEdge) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      label: e.label,
    })),
    updatedAt: new Date().toISOString(),
    version: 0,
    dirty: true,
    schedule: {
      enabled: false,
      frequency: parsed.schedule.frequency,
      time: parsed.schedule.time,
      timezone: parsed.schedule.timezone,
      days: parsed.schedule.days,
    },
    sharing: { visibility: "private", teams: [], permission: "run" },
  };
}
