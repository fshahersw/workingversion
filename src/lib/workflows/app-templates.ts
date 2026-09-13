import { makeStep } from "./catalog.ts";
import type { AppField, StepConfig, Workflow } from "./types";
export type TemplateGuide = {
  roles: string[];
  stage: string;
  inputGuide: string;
  process: string[];
  reviewChecks: string[];
  reviewer: string;
  cadence: string;
  boundary: string;
};
export type AppTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tone: string;
  recipe: string;
  input: string;
  output: string;
  fields: AppField[];
  config?: StepConfig;
  mode: "Local" | "Web connection" | "Bedrock analysis";
  source: string;
  guide?: TemplateGuide;
};
const field = (
  id: string,
  label: string,
  type: AppField["type"],
  value = "",
  options?: string[],
): AppField => ({ id, label, type, value, options, required: false });
const extras: Record<string, AppField[]> = {
  "plaintiff-intake": [
    field("role", "Roles to include", "select", "Plaintiffs", [
      "Plaintiffs",
      "Defendants",
      "Witnesses",
      "All roles",
    ]),
  ],
  "daily-mail": [field("since", "Include messages from", "date")],
  "custom-intake": [
    field("columns", "Field labels to extract", "textarea", "Plaintiffs, Defendants, Date, Matter"),
  ],
  "page-monitor": [{ ...field("url", "Page to monitor", "url"), required: true }],
  "matter-brief": [
    field("audience", "Written for", "select", "Case team", [
      "Case team",
      "Leadership",
      "Client-facing",
    ]),
    field(
      "focus",
      "Focus areas",
      "textarea",
      "Procedural posture, key rulings and orders, upcoming deadlines, open motions, next steps",
    ),
  ],
};
// [id, name, description, category, icon, recipe, input, output]
const data = [
  [
    "plaintiff-intake",
    "Deposition plaintiff extractor",
    "Collect explicitly identified plaintiffs with a reference for every name.",
    "Litigation",
    "Users",
    "parties",
    "Deposition PDF, DOCX or text",
    "Plaintiff register",
  ],
  [
    "case-chronology",
    "Case chronology",
    "Arrange explicit dates and surrounding source text into a reviewable timeline.",
    "Litigation",
    "CalendarClock",
    "chronology",
    "Orders, correspondence or transcripts",
    "Chronology",
  ],
  [
    "cross-analysis",
    "Cross-document comparison",
    "Isolate added and removed text between two accounts or versions for factual review.",
    "Litigation",
    "Files",
    "compare",
    "Two documents, baseline first",
    "Text differences",
  ],
  [
    "bluebook-check",
    "Bluebook citation review",
    "Screen common citation components and build an authority-verification checklist.",
    "Drafting",
    "BookOpen",
    "citations",
    "Brief, memo or citation list",
    "Format flags + verification queue",
  ],
  [
    "humanizer",
    "Plain-language humanizer",
    "Simplify wordy phrases with a visible change log while preserving quoted and citation-bearing lines.",
    "Drafting",
    "WandSparkles",
    "plain",
    "Draft DOCX or pasted text",
    "Edited draft + change log",
  ],
  [
    "matter-brief",
    "Matter brief",
    "Turn the orders, filings and notes for one matter into a concise team brief with source references.",
    "Research",
    "NotebookText",
    "brief",
    "Orders, filings, correspondence or notes for one matter",
    "Team brief (Word)",
  ],
  [
    "daily-mail",
    "Daily email briefing",
    "Review supplied email exports by date, sender, subject and explicit follow-up requests.",
    "Email & meetings",
    "Mail",
    "emails",
    "EML files or plain email exports",
    "Email briefing",
  ],
  [
    "email-followups",
    "Email action queue",
    "Extract action wording from email and show missing owners or dates.",
    "Email & meetings",
    "CheckCheck",
    "actions",
    "Email exports or pasted thread",
    "Follow-up queue",
  ],
  [
    "voice-notes",
    "Voice notes to action list",
    "Dictate or paste notes, then collect explicit commitments for review.",
    "Email & meetings",
    "Mic",
    "actions",
    "Dictation or a text transcript",
    "Meeting action list",
  ],
  [
    "custom-intake",
    "Custom intake extractor",
    "Choose labeled fields to collect and create a repeatable upload app.",
    "Intake & operations",
    "ScanText",
    "fields",
    "Labeled intake documents",
    "Custom field register",
  ],
  [
    "page-monitor",
    "Website change monitor",
    "Keep a baseline and turn additions and removals into a review report.",
    "Intake & operations",
    "Bell",
    "changes",
    "Public URL or two snapshots",
    "Change report",
  ],
];
export function baseTemplateGuide(id: string, category: string, input: string): TemplateGuide {
  const roles =
    id === "matter-brief"
      ? ["Litigating attorney", "Case manager", "Leadership"]
      : category === "Drafting"
        ? ["Litigating attorney", "Research attorney", "Litigation paralegal"]
        : category === "Email & meetings"
          ? ["Case manager", "Client liaison", "Leadership"]
          : category === "Research"
            ? ["Research attorney", "Knowledge management"]
            : category === "Intake & operations"
              ? ["Litigation paralegal", "Discovery / litigation support", "Managing clerk / MCO"]
              : ["Litigating attorney", "Litigation paralegal", "Case manager"];
  return {
    roles,
    stage:
      id === "matter-brief"
        ? "Case management"
        : category === "Drafting"
          ? "Motions"
          : category === "Email & meetings"
            ? "Case management"
            : category === "Intake & operations"
              ? "Firm operations"
              : "Discovery",
    inputGuide: input,
    process:
      id === "matter-brief"
        ? [
            "Upload the orders, filings, correspondence or notes that define where the matter stands.",
            "Choose the audience and adjust the focus areas.",
            "Review the brief against the sources, then save it to Word.",
          ]
        : [
            "Inspect the required input format and source coverage.",
            "Load your sources and configure the available fields.",
            "Review the source excerpts and scope notes, then export the working paper.",
          ],
    reviewChecks:
      id === "matter-brief"
        ? [
            "Confirm every statement in the brief traces to a supplied document.",
            "Check dates and deadlines against the original orders before circulating.",
            "Treat the brief as a draft; the responsible attorney signs off.",
          ]
        : [
            "Verify source identity and read coverage.",
            "Inspect the original before relying on a finding.",
            "Use a connected approved model for semantic work beyond the stated local recipe.",
          ],
    reviewer: "Responsible attorney or case-team reviewer",
    cadence:
      id === "matter-brief"
        ? "Before team meetings or on new significant filings"
        : "On demand or after updated source material",
    boundary:
      id === "matter-brief"
        ? "Bedrock drafts from the supplied documents only. It does not search the docket or the knowledge base; use the Matter briefing template in the builder for that."
        : "Local capabilities are described in the app. Use configured server services for account access and scheduling. Legal conclusions require review; email delivery is not enabled.",
  };
}
export const appTemplates: AppTemplate[] = data.map(
  ([id, name, description, category, icon, recipe, input, output]) => ({
    id,
    name,
    description,
    category,
    icon,
    recipe,
    input,
    output,
    guide: baseTemplateGuide(id, category, input),
    fields: extras[id] || [],
    tone: category === "Drafting" ? "green" : category === "Research" ? "amber" : "blue",
    mode:
      id === "page-monitor"
        ? "Web connection"
        : id === "matter-brief"
          ? "Bedrock analysis"
          : "Local",
    source:
      recipe === "citations"
        ? "https://www.law.cornell.edu/citation/2-200"
        : category === "Litigation"
          ? "https://legora.com/product/tabular-review"
          : "https://www.harvey.ai/blog/top-harvey-use-cases",
  }),
);
const BRIEF_INSTRUCTIONS = [
  "Write a concise matter brief for the {{input.fields.audience}} from the supplied documents only.",
  "Focus areas: {{input.fields.focus}}.",
  "Structure: one-paragraph status, then short sections per focus area, then open items and next steps.",
  "Every factual statement carries a source reference (document name and page or line where available).",
  "Separate what the documents establish from what remains open. Do not calculate legal deadlines or draw legal conclusions; flag them for the responsible attorney.",
].join(" ");
export function createAppWorkflow(id: string, reviewGate = false): Workflow {
  const t = appTemplates.find((t) => t.id === id);
  if (!t) throw new Error("Unknown template.");
  const start = makeStep("trigger", 1, { x: 250, y: 10 });
  start.data.output = "input";
  start.data.label = t.mode === "Web connection" ? "Research requested" : "Files or text received";
  const input = makeStep(id === "page-monitor" ? "scrape" : "files", 2, { x: 250, y: 145 });
  input.data.output = "sources";
  if (id === "page-monitor")
    input.data.config = {
      connection: "public-web",
      url: "{{input.fields.url}}",
      tool: "monitor-page",
    };
  const action =
    id === "matter-brief"
      ? makeStep("prompt", 3, { x: 250, y: 280 })
      : makeStep("recipe", 3, { x: 250, y: 280 });
  action.data.label = t.name;
  action.data.output = "analysis";
  action.data.config =
    id === "matter-brief"
      ? { model: "bedrock", instructions: BRIEF_INSTRUCTIONS, context: ["sources"] }
      : { recipe: t.recipe, ...t.config, context: ["sources"] };
  const document = makeStep("document", 4, { x: 250, y: 415 });
  document.data.config = { format: "docx", filename: t.name };
  const end = makeStep("response", 5, { x: 250, y: 550 });
  const review = makeStep("review", 6, { x: 250, y: 415 });
  review.data.label = "Review evidence and resolve exceptions";
  review.data.config.reviewer = "owner";
  if (reviewGate) {
    document.position.y = 550;
    end.position.y = 685;
  }
  const nodes = [start, input, action, ...(reviewGate ? [review] : []), document, end];
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: t.name,
    description: t.description,
    category: t.category,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: crypto.randomUUID(),
      source: nodes[i].id,
      target: n.id,
    })),
    updatedAt: new Date().toISOString(),
    createdBy: "",
    version: 0,
    dirty: true,
    sharing: { visibility: "private", teams: [], permission: "run" },
    schedule: {
      enabled: false,
      frequency: "weekly",
      time: "09:00",
      timezone: "America/New_York",
      days: [1],
    },
    app: {
      templateId: id,
      description: t.description,
      autoRunOnUpload: false,
      fields: structuredClone(t.fields),
    },
  };
}
