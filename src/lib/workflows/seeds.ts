import { definition } from "./catalog.ts";
import type { Workflow, WorkflowEdge, WorkflowStep, RunInputs, StepKind } from "./types";
function node(
  id: string,
  kind: StepKind,
  label: string,
  output: string,
  x: number,
  y: number,
  config: WorkflowStep["data"]["config"] = {},
): WorkflowStep {
  return {
    id,
    type: "step",
    position: { x, y },
    data: {
      kind,
      label,
      output,
      config: { ...structuredClone(definition(kind).config), ...config },
    },
  };
}
function edge(source: string, target: string, handle?: string): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    ...(handle
      ? {
          sourceHandle: handle,
          label: handle === "true" ? "Needs review" : "Clear to proceed",
        }
      : {}),
  };
}
export function baseWorkflow(
  id: string,
  name: string,
  description: string,
  category = "Litigation",
): Workflow {
  return {
    schemaVersion: 1,
    id,
    name,
    description,
    category,
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
    createdBy: "",
    version: 0,
    dirty: true,
    schedule: {
      enabled: false,
      frequency: "weekly",
      time: "09:00",
      timezone: "America/New_York",
      days: [1],
    },
    sharing: { visibility: "private", teams: [], permission: "run" },
  };
}
export function triageWorkflow(): Workflow {
  return {
    ...baseWorkflow(
      "litigation-triage",
      "Litigation document triage",
      "Extract key facts, flag privileged material, and prepare a review memorandum.",
    ),
    nodes: [
      node("start", "trigger", "Documents received", "input", 250, 10),
      node("choice", "selection", "Review preference", "preference", 250, 100, {
        options: ["Attorney review", "Draft only"],
      }),
      node("extract", "extract", "Extract key information", "extraction", 250, 120),
      node("route", "condition", "Attorney review requested?", "routing", 250, 285, {
        left: "preference.selection",
        operator: "equals",
        right: "Attorney review",
      }),
      node("review", "review", "Request attorney review", "review", 70, 370, {
        reviewer: "owner",
        instructions:
          "Review the flagged source material. Confirm whether the workflow may prepare a draft memorandum.",
      }),
      node("summary", "prompt", "Summarize the findings", "summary", 430, 370, {
        context: ["extraction"],
        instructions:
          "Summarize the extracted findings for the case team. Separate supplied facts from open questions. Preserve source references; do not calculate legal deadlines.",
      }),
      node("document", "document", "Create review memorandum", "memorandum", 250, 500, {
        filename: "Litigation review memorandum",
        format: "docx",
      }),
      node("response", "response", "Present the result", "result", 250, 610),
    ],
    edges: [
      edge("start", "choice"),
      edge("choice", "extract"),
      edge("extract", "route"),
      edge("route", "review", "true"),
      edge("route", "summary", "false"),
      edge("review", "summary"),
      edge("summary", "document"),
      edge("document", "response"),
    ],
  };
}
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tone: string;
  kinds: StepKind[];
  outcome: string;
};
export const templates: WorkflowTemplate[] = [
  {
    id: "triage",
    name: "Litigation document triage",
    description: "Extract facts, route sensitive material for review, and draft a memorandum.",
    category: "Litigation",
    icon: "GitBranch",
    tone: "purple",
    kinds: ["trigger", "extract", "condition", "review", "prompt", "document", "response"],
    outcome: "Review memorandum",
  },
  {
    id: "deposition",
    name: "Deposition digest",
    description: "Turn testimony into a structured digest with issues and source references.",
    category: "Litigation",
    icon: "MessagesSquare",
    tone: "blue",
    kinds: ["trigger", "files", "extract", "prompt", "document", "response"],
    outcome: "Word digest",
  },
  {
    id: "discovery",
    name: "Discovery response review",
    description: "Build a document review table and prepare follow-up questions for counsel.",
    category: "Litigation",
    icon: "Table2",
    tone: "amber",
    kinds: ["trigger", "table", "prompt", "review", "document", "response"],
    outcome: "Review table & report",
  },
  {
    id: "contract",
    name: "Contract comparison",
    description: "Compare two agreements, identify changed language, and prepare a summary.",
    category: "Transactional",
    icon: "Files",
    tone: "teal",
    kinds: ["trigger", "compare", "prompt", "review", "document", "response"],
    outcome: "Change summary",
  },
  {
    id: "citation",
    name: "Citation quality check",
    description: "Screen citation formatting and create a checklist for source verification.",
    category: "Knowledge",
    icon: "BookOpen",
    tone: "rose",
    kinds: ["trigger", "citations", "review", "document", "response"],
    outcome: "Citation checklist",
  },
  {
    id: "briefing",
    name: "Matter briefing",
    description: "Combine matter information and relevant playbooks into a concise team brief.",
    category: "Knowledge",
    icon: "NotebookText",
    tone: "green",
    kinds: ["trigger", "search", "prompt", "document", "notify", "response"],
    outcome: "Brief & email draft",
  },
];
export function fromTemplate(id: string): Workflow {
  const template = templates.find((t) => t.id === id) || templates[0];
  if (template.id === "triage") return { ...triageWorkflow(), id: crypto.randomUUID() };
  const flow = baseWorkflow(
    crypto.randomUUID(),
    template.name,
    template.description,
    template.category,
  );
  flow.nodes = template.kinds.map((kind, i) =>
    node(
      `step-${i + 1}`,
      kind,
      definition(kind).label,
      `${kind}_${i + 1}`,
      280,
      15 + i * 135,
      kind === "document" ? { filename: template.outcome } : {},
    ),
  );
  flow.edges = flow.nodes.slice(1).map((n, i) => edge(flow.nodes[i].id, n.id));
  return flow;
}
export function blankWorkflow(name = "Untitled workflow"): Workflow {
  return {
    ...baseWorkflow(
      crypto.randomUUID(),
      name,
      "Add steps to turn your team's process into a reusable workflow.",
    ),
    nodes: [
      node("start", "trigger", "Start workflow", "input", 260, 30),
      node("finish", "response", "Present the result", "result", 260, 200),
    ],
    edges: [edge("start", "finish")],
  };
}
