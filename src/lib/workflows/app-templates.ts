import { makeStep } from "./catalog.ts";
import { baseTemplateGuide, practiceTemplates, type TemplateGuide } from "./practice-templates.ts";
import type { AppField, RunInputs, StepConfig, Workflow } from "./types";
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
  mode: "Local" | "Web connection";
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
  "people-map": [
    field("role", "Roles to include", "select", "All roles", [
      "All roles",
      "Plaintiffs",
      "Defendants",
      "Witnesses",
    ]),
  ],
  "testimony-issues": [
    field("issues", "Issues to find", "textarea", "notice, warning, injury, training"),
  ],
  "privilege-queue": [field("reviewer", "Assigned reviewer", "text", "")],
  "contract-clauses": [
    field(
      "issues",
      "Clause topics",
      "textarea",
      "liability, indemnification, termination, assignment, governing law",
    ),
  ],
  "policy-evidence": [
    field(
      "issues",
      "Topics or obligations",
      "textarea",
      "confidentiality, retention, security, notice",
    ),
  ],
  "daily-mail": [field("since", "Include messages from", "date")],
  "exhibit-index": [field("prefix", "Exhibit prefix", "text", "EX")],
  "custom-intake": [
    field("columns", "Field labels to extract", "textarea", "Plaintiffs, Defendants, Date, Matter"),
  ],
  "web-research": [{ ...field("query", "Research query", "text"), required: true }],
  "page-reader": [{ ...field("url", "Public page URL", "url"), required: true }],
  "page-monitor": [{ ...field("url", "Page to monitor", "url"), required: true }],
};
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
    "deposition",
  ],
  [
    "people-map",
    "People & witness register",
    "Index named parties, witnesses and counsel from explicit role labels.",
    "Litigation",
    "Users",
    "parties",
    "Case materials with role labels",
    "People register",
    "deposition",
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
    "deposition",
  ],
  [
    "treatment-timeline",
    "Treatment record timeline",
    "Index dated treatment entries without inventing diagnoses, causation or missing visits.",
    "Litigation",
    "ListFilter",
    "chronology",
    "Text-based treatment records",
    "Dated source entries",
    "medical",
  ],
  [
    "testimony-issues",
    "Testimony issue matrix",
    "Find passages for your issue list and retain the supporting text beside each match.",
    "Litigation",
    "Table2",
    "issues",
    "One or more transcripts",
    "Issue / evidence matrix",
    "deposition",
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
    "comparison",
  ],
  [
    "discovery-matrix",
    "Discovery response matrix",
    "Pair numbered requests with adjacent response and objection text for deficiency review.",
    "Litigation",
    "Table2",
    "requests",
    "Numbered requests and responses",
    "Request / response matrix",
    "discovery",
  ],
  [
    "privilege-queue",
    "Privilege screening queue",
    "Flag privilege-related wording for an attorney to review before any withholding decision.",
    "Litigation",
    "ShieldCheck",
    "privilege",
    "Production or correspondence excerpts",
    "Potential privilege queue",
    "discovery",
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
    "citations",
  ],
  [
    "authority-index",
    "Authority inventory",
    "Collect citation candidates in one place for source and subsequent-history checks.",
    "Drafting",
    "NotebookText",
    "citations",
    "Brief or research memorandum",
    "Citation inventory",
    "citations",
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
    "draft",
  ],
  [
    "client-update",
    "Client update editor",
    "Make a draft update more direct, with every phrase substitution available for review.",
    "Drafting",
    "FilePenLine",
    "plain",
    "Existing client update",
    "Plain-language draft",
    "draft",
  ],
  [
    "contract-clauses",
    "Contract clause review",
    "Collect important clause text beside review questions for your approved playbook.",
    "Contracts",
    "FileCheck2",
    "clauses",
    "Contract or agreement set",
    "Clause matrix",
    "contract",
  ],
  [
    "nda-redline",
    "NDA version comparison",
    "Compare a baseline with a counterparty version and isolate textual changes for counsel.",
    "Contracts",
    "Files",
    "compare",
    "Two NDA versions",
    "Text difference report",
    "comparison",
  ],
  [
    "policy-evidence",
    "Policy evidence matrix",
    "Collect relevant passages for an obligation list without inferring compliance.",
    "Research",
    "ShieldCheck",
    "issues",
    "Policies or public guidance",
    "Topic / evidence matrix",
    "contract",
  ],
  [
    "obligation-tracker",
    "Obligation & commitment log",
    "Pull explicit commitments and dates into a list for ownership review.",
    "Contracts",
    "CheckCheck",
    "actions",
    "Contract or meeting notes",
    "Action / owner / date register",
    "contract",
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
    "emails",
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
    "emails",
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
    "meeting",
  ],
  [
    "exhibit-index",
    "Exhibit & file manifest",
    "Create a consistent batch index with suggested exhibit numbers and source sizes.",
    "Intake & operations",
    "FolderOpen",
    "manifest",
    "Selected folder or file batch",
    "Exhibit manifest",
    "comparison",
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
    "deposition",
  ],
  [
    "web-research",
    "Public research brief",
    "Search reference sources and collect links. General web search is available with Firecrawl.",
    "Research",
    "Search",
    "webbrief",
    "Research query",
    "Linked sources + reading brief",
    "web",
  ],
  [
    "page-reader",
    "Web page to research note",
    "Extract readable text from a public page with its URL and retrieval time.",
    "Research",
    "Globe",
    "webbrief",
    "Public HTTPS URL",
    "Source excerpts",
    "web",
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
    "comparison",
  ],
];
const baseTemplates: AppTemplate[] = data.map(
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
    tone: category === "Drafting" ? "green" : category === "Contracts" ? "amber" : "blue",
    mode: ["web-research", "page-reader", "page-monitor"].includes(id) ? "Web connection" : "Local",
    source:
      recipe === "citations"
        ? "https://www.law.cornell.edu/citation/2-200"
        : category === "Litigation"
          ? "https://legora.com/product/tabular-review"
          : "https://www.harvey.ai/blog/top-harvey-use-cases",
  }),
);
export const appTemplates: AppTemplate[] = [...baseTemplates, ...practiceTemplates];
export function createAppWorkflow(id: string, reviewGate = false): Workflow {
  const t = appTemplates.find((t) => t.id === id);
  if (!t) throw new Error("Unknown template.");
  const start = makeStep("trigger", 1, { x: 250, y: 10 });
  start.data.output = "input";
  start.data.label = t.mode === "Web connection" ? "Research requested" : "Files or text received";
  const input = makeStep(
    id === "web-research"
      ? "web"
      : ["page-reader", "page-monitor"].includes(id)
        ? "scrape"
        : "files",
    2,
    { x: 250, y: 145 },
  );
  input.data.output = "sources";
  if (id === "web-research")
    input.data.config = {
      connection: "web-search",
      query: "{{input.fields.query}}",
    };
  if (["page-reader", "page-monitor"].includes(id))
    input.data.config = {
      connection: "public-web",
      url: "{{input.fields.url}}",
      ...(id === "page-monitor" ? { tool: "monitor-page" } : {}),
    };
  const action = makeStep("recipe", 3, { x: 250, y: 280 });
  action.data.label = t.name;
  action.data.output = "analysis";
  action.data.config = { recipe: t.recipe, ...t.config, context: ["sources"] };
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
