import type { StepConfig, StepKind, WorkflowStep } from "./types";
export type StepDefinition = {
  kind: StepKind;
  label: string;
  description: string;
  group: string;
  icon: string;
  tone: string;
  config: StepConfig;
};
export const catalog: StepDefinition[] = [
  {
    kind: "trigger",
    label: "Start workflow",
    description: "Run manually or on a schedule",
    group: "Inputs & triggers",
    icon: "Play",
    tone: "green",
    config: {},
  },
  {
    kind: "files",
    label: "File upload",
    description: "Read PDF or text documents",
    group: "Inputs & triggers",
    icon: "FileUp",
    tone: "blue",
    config: {},
  },
  {
    kind: "text",
    label: "Text input",
    description: "Collect instructions or matter context",
    group: "Inputs & triggers",
    icon: "TextCursorInput",
    tone: "blue",
    config: { value: "" },
  },
  {
    kind: "selection",
    label: "Selection list",
    description: "Give users a set of choices",
    group: "Inputs & triggers",
    icon: "ListFilter",
    tone: "blue",
    config: { options: ["Standard", "Detailed", "Urgent"] },
  },
  {
    kind: "prompt",
    label: "Prompt",
    description: "Apply instructions to prior outputs",
    group: "AI & legal work",
    icon: "Sparkles",
    tone: "purple",
    config: {
      instructions:
        "Summarize the source documents. Identify key facts and questions for the case team. Cite source line numbers where available.",
      model: "bedrock",
      context: [],
    },
  },
  {
    kind: "agent",
    label: "AI agent",
    description: "Define a task, context, and tools",
    group: "AI & legal work",
    icon: "Bot",
    tone: "purple",
    config: {
      instructions:
        "Review the supplied material and prepare a concise briefing. Flag missing evidence.",
      model: "bedrock",
      context: [],
      tool: "Document analysis",
    },
  },
  {
    kind: "extract",
    label: "Extract data",
    description: "Turn documents into structured fields",
    group: "AI & legal work",
    icon: "ScanText",
    tone: "teal",
    config: {
      fields: ["matter", "dates", "parties", "privileged", "citations"],
    },
  },
  {
    kind: "table",
    label: "Tabular review",
    description: "Review documents side by side",
    group: "AI & legal work",
    icon: "Table2",
    tone: "amber",
    config: {
      fields: ["Document", "Key finding", "Review required", "Source"],
    },
  },
  {
    kind: "compare",
    label: "Compare documents",
    description: "Find changes across two sources",
    group: "AI & legal work",
    icon: "Files",
    tone: "teal",
    config: {},
  },
  {
    kind: "citations",
    label: "Citation review",
    description: "Screen citation format and references",
    group: "AI & legal work",
    icon: "BookOpen",
    tone: "purple",
    config: {
      instructions:
        "Screen case citations for a reporter reference and year. Flag items for attorney verification.",
    },
  },
  {
    kind: "search",
    label: "Knowledge search",
    description: "Look up precedents and playbooks",
    group: "AI & legal work",
    icon: "Database",
    tone: "amber",
    config: { query: "discovery", connection: "workspace" },
  },
  {
    kind: "condition",
    label: "Condition",
    description: "Route a true or false branch",
    group: "Logic & review",
    icon: "GitBranch",
    tone: "amber",
    config: { left: "extraction.privileged", operator: "is_true", right: "" },
  },
  {
    kind: "review",
    label: "Human review",
    description: "Pause for a person's decision",
    group: "Logic & review",
    icon: "UserRoundCheck",
    tone: "rose",
    config: {
      reviewer: "owner",
      instructions: "Review the source material and approve the next step.",
    },
  },
  {
    kind: "foreach",
    label: "For each document",
    description: "Build a batch from all input files",
    group: "Logic & review",
    icon: "Repeat2",
    tone: "amber",
    config: {},
  },
  {
    kind: "merge",
    label: "Merge outputs",
    description: "Combine the branches that ran",
    group: "Logic & review",
    icon: "Merge",
    tone: "slate",
    config: {},
  },
  {
    kind: "delay",
    label: "Wait",
    description: "Resume after a timed interval",
    group: "Logic & review",
    icon: "Clock3",
    tone: "slate",
    config: { seconds: 10 },
  },
  {
    kind: "document",
    label: "Create document",
    description: "Produce a Word, PDF, or text file",
    group: "Outputs & tools",
    icon: "FilePlus2",
    tone: "green",
    config: {
      filename: "Review memorandum",
      format: "docx",
      instructions: "Prepare a review memorandum from the completed workflow steps.",
    },
  },
  {
    kind: "edit",
    label: "Edit document",
    description: "Apply a local replacement or edit brief",
    group: "Outputs & tools",
    icon: "FilePenLine",
    tone: "green",
    config: {
      left: "[CLIENT]",
      right: "Demo Client",
      instructions: "Replace the specified text in the first input document.",
    },
  },
  {
    kind: "response",
    label: "Response",
    description: "Present the final result to the user",
    group: "Outputs & tools",
    icon: "MessageSquareText",
    tone: "green",
    config: {},
  },
  {
    kind: "notify",
    label: "Prepare notification",
    description: "Draft a message for your team",
    group: "Outputs & tools",
    icon: "Mail",
    tone: "blue",
    config: {
      recipients: ["litigation-team@example.com"],
      instructions: "The workflow is ready for your review.",
    },
  },
  {
    kind: "python",
    label: "Python transform",
    description: "Connect a sandboxed Python runtime",
    group: "Outputs & tools",
    icon: "Code2",
    tone: "slate",
    config: {
      code: '# Input is provided as context\n# Return JSON-serializable output\nresult = {"document_count": len(context["files"])}',
      connection: "",
    },
  },
  {
    kind: "mcp",
    label: "MCP tool",
    description: "Use an approved platform connection",
    group: "Outputs & tools",
    icon: "Plug2",
    tone: "slate",
    config: {
      connection: "workspace",
      tool: "search_documents",
      query: "discovery",
    },
  },
];
catalog.push(
  {
    kind: "recipe",
    label: "Structured legal analysis",
    description: "Run an evidence-based template processor",
    group: "AI & legal work",
    icon: "Table2",
    tone: "green",
    config: {
      recipe: "parties",
      instructions: "Keep source references. Flag ambiguity for review.",
    },
  },
  {
    kind: "web",
    label: "Web search",
    description: "Search public sources through a web connection",
    group: "Outputs & tools",
    icon: "Search",
    tone: "blue",
    config: { connection: "wikipedia", query: "{{input.text}}" },
  },
  {
    kind: "scrape",
    label: "Read web page",
    description: "Extract a public page with source attribution",
    group: "Outputs & tools",
    icon: "Globe",
    tone: "blue",
    config: { connection: "public-web", url: "https://www.uscourts.gov" },
  },
);
export const definition = (kind: StepKind) => catalog.find((item) => item.kind === kind)!;
export function makeStep(
  kind: StepKind,
  sequence: number,
  position = { x: 260, y: 30 },
): WorkflowStep {
  const d = definition(kind);
  return {
    id: crypto.randomUUID(),
    type: "step",
    position,
    data: {
      kind,
      label: d.label,
      output: `${kind}_${sequence}`,
      config: structuredClone(d.config),
    },
  };
}
export const groups = [...new Set(catalog.map((item) => item.group))];
