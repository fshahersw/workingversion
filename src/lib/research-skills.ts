/**
 * Research skills: named verbs with optional mini-forms.
 *
 * A skill is not a starter card. It collects the few fields that actually
 * change the research, then composes a specific question the agent can run
 * (and that the clarification detectors will skip when those fields settle
 * the fork). Invoked from the landing row or as `/` commands in the composer.
 */
import type { MatterScope } from "@/lib/chat-types";

/** Toolkit categories; array order defines the tab order in the toolkit. */
export const SKILL_CATEGORIES = [
  "Case strategy",
  "Evidence & experts",
  "Matter intelligence",
  "Practice tools",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Which toolkit category each skill belongs to (keyed by skill id). */
export const SKILL_CATEGORY: Record<string, SkillCategory> = {
  bellwether: "Case strategy",
  rule702: "Case strategy",
  limitations: "Case strategy",
  causation: "Evidence & experts",
  recall: "Evidence & experts",
  docket: "Matter intelligence",
  settlement: "Matter intelligence",
  intake: "Practice tools",
};

/** A matter document chosen as a focus source in the composer's Sources popover. */
export type SelectedDoc = { id: string; title: string };

export type SkillField = {
  id: string;
  label: string;
  placeholder: string;
  required?: boolean;
  /** "select" renders a closed list; default is a text input. */
  kind?: "text" | "select";
  options?: { id: string; label: string }[];
};

export type ResearchSkill = {
  id: string;
  slash: string;
  label: string;
  hint: string;
  fields: SkillField[];
  compose: (values: Record<string, string>) => string;
};

function v(values: Record<string, string>, id: string): string {
  return (values[id] ?? "").replace(/\s+/g, " ").trim();
}

export const RESEARCH_SKILLS: ResearchSkill[] = [
  {
    id: "bellwether",
    slash: "bellwether",
    label: "Bellwether schedule",
    hint: "Next trial setting, track, and transferee court",
    fields: [
      { id: "matter", label: "Matter", placeholder: "Depo-Provera, Paraquat MDL 3004…", required: true },
      {
        id: "track",
        label: "Track",
        placeholder: "Both tracks",
        kind: "select",
        options: [
          { id: "both", label: "Both tracks (federal + state)" },
          { id: "federal", label: "Federal MDL" },
          { id: "state", label: "State coordinated proceedings" },
        ],
      },
    ],
    compose: (values) => {
      const matter = v(values, "matter");
      const track = v(values, "track") || "both";
      const scope =
        track === "federal"
          ? "Focus on the federal MDL (JPML / transferee court)."
          : track === "state"
            ? "Focus on state coordinated proceedings (JCCP, MCC, or the relevant state coordination)."
            : "Cover both the federal MDL and state coordinated proceedings, distinguishing the two tracks.";
      return `What is the current bellwether schedule and next trial setting in ${matter}? ${scope} Identify the presiding court, the most recent CMO/PTO that sets trials, pick cases, and any vacated or continued dates. Cite the order and date for each milestone.`;
    },
  },
  {
    id: "causation",
    slash: "causation",
    label: "Causation sweep",
    hint: "Epidemiology, experts, and Rule 702 rulings",
    fields: [
      { id: "exposure", label: "Product / exposure", placeholder: "Talc, Roundup, hair relaxer…", required: true },
      { id: "injury", label: "Injury", placeholder: "Ovarian cancer, NHL…" },
      { id: "window", label: "Window", placeholder: "Last 5 years (optional)" },
    ],
    compose: (values) => {
      const exposure = v(values, "exposure");
      const injury = v(values, "injury");
      const window = v(values, "window");
      const of = injury ? ` and ${injury}` : "";
      const when = window ? ` Limit the sweep to ${window}.` : "";
      return `Sweep the general-causation record for ${exposure}${of}: the key epidemiological and toxicology studies, the plaintiffs' and defense experts who rely on them, and recent Rule 702 / Daubert rulings on those methods.${when} Separate supporting from excluding opinions and cite the study or ruling with date.`;
    },
  },
  {
    id: "rule702",
    slash: "702",
    label: "Rule 702 compare",
    hint: "Side-by-side expert rulings",
    fields: [
      { id: "left", label: "First matter or expert", placeholder: "Talc / Dr. Smith", required: true },
      { id: "right", label: "Second matter or expert", placeholder: "Roundup / Dr. Jones", required: true },
    ],
    compose: (values) => {
      const left = v(values, "left");
      const right = v(values, "right");
      return `Compare how courts have applied Rule 702 / Daubert to general-causation experts in ${left} versus ${right}. Identify the holdings, the methods at issue, whether the expert was admitted or excluded, and any circuit split. Cite the opinion, court, and date for each ruling.`;
    },
  },
  {
    id: "intake",
    slash: "intake",
    label: "Intake criteria",
    hint: "Screening memo a team can apply",
    fields: [
      { id: "product", label: "Product", placeholder: "Paraquat, hernia mesh…", required: true },
      { id: "jurisdictions", label: "Jurisdictions", placeholder: "IL, CA, NY — or survey" },
      {
        id: "format",
        label: "Deliver as",
        placeholder: "Chat",
        kind: "select",
        options: [
          { id: "chat", label: "Answer in chat" },
          { id: "pdf", label: "PDF memo" },
          { id: "docx", label: "Word document" },
        ],
      },
    ],
    compose: (values) => {
      const product = v(values, "product");
      const jurisdictions = v(values, "jurisdictions");
      // Blank must still read as a sentence ("…and repose in survey the key
      // filing states" was both ungrammatical and a jurisdiction fork the
      // clarification panel would then ask about).
      const solScope = jurisdictions
        ? `statutes of limitations and repose in ${jurisdictions}`
        : "statutes of limitations and repose across the key filing states, without treating one state's rule as national";
      const format = v(values, "format") || "chat";
      const deliver =
        format === "pdf"
          ? "Deliver as a PDF report."
          : format === "docx"
            ? "Deliver as a Word document."
            : "Answer in chat only; do not generate a file.";
      return `Draft plaintiff-intake screening criteria for ${product} claims. Cover exposure/use, injury, diagnosed-by date, ${solScope}, and any MDL/JCCP census or fact-sheet traps. Make it operational for an intake team. ${deliver}`;
    },
  },
  {
    id: "limitations",
    slash: "sol",
    label: "Limitations / repose",
    hint: "Accrual, tolling, and filing deadlines",
    fields: [
      { id: "claim", label: "Claim / product", placeholder: "Paraquat Parkinson’s, talc…", required: true },
      { id: "state", label: "State", placeholder: "Illinois, or leave blank to survey" },
    ],
    compose: (values) => {
      const claim = v(values, "claim");
      const state = v(values, "state");
      const where = state
        ? `Limit the analysis to ${state}: apply its limitations, repose, and tolling rules, and flag other states only as contrast.`
        : "Survey the key filing states and do not treat one state's rule as national.";
      return `What is the statute of limitations and repose analysis for ${claim}? ${where} Cover accrual, the discovery rule, cross-jurisdictional tolling if an MDL is pending, and the practical filing deadline. Cite the statute or controlling case with date.`;
    },
  },
  {
    id: "docket",
    slash: "docket",
    label: "Docket recency",
    hint: "Latest CMO, PTO, or opinion",
    fields: [
      { id: "case", label: "Case / MDL", placeholder: "MDL 3004, In re Zantac…", required: true },
    ],
    compose: (values) => {
      const cse = v(values, "case");
      return `What is the current posture of ${cse}? Lead with the most recent CMO, PTO, transfer order, or opinion — date, docket number, and what it actually does. Then the live schedule (next conference, discovery cutoff, trial setting) and any pending motions that move the case.`;
    },
  },
  {
    id: "settlement",
    slash: "settlement",
    label: "Settlement status",
    hint: "Agreements, matrices, common benefit",
    fields: [
      { id: "matter", label: "Matter", placeholder: "3M combat arms, AFFF…", required: true },
    ],
    compose: (values) => {
      const matter = v(values, "matter");
      return `What is the current settlement status in ${matter}? Identify the operative agreement, allocation or matrix, common-benefit orders, registration/opt-out deadlines, and figures that still need docket confirmation. Cite the agreement or order and date.`;
    },
  },
  {
    id: "recall",
    slash: "recall",
    label: "Recall / regulatory",
    hint: "FDA, CPSC, NHTSA primary records",
    fields: [
      { id: "product", label: "Product", placeholder: "CPAP, airbag inflator…", required: true },
    ],
    compose: (values) => {
      const product = v(values, "product");
      return `What are the current FDA, CPSC, or other agency actions on ${product}? Prioritize primary records: recalls, warning letters, MAUDE or similar adverse-event data, labeling changes, with exact dates and the agency docket or letter number.`;
    },
  },
];

export function skillBySlash(token: string): ResearchSkill | undefined {
  const t = token.replace(/^\//, "").trim().toLowerCase();
  if (!t) return undefined;
  return RESEARCH_SKILLS.find((s) => s.slash === t || s.id === t);
}

export function filterSkills(query: string): ResearchSkill[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return RESEARCH_SKILLS;
  return RESEARCH_SKILLS.filter(
    (s) =>
      s.slash.startsWith(q) ||
      s.id.startsWith(q) ||
      s.label.toLowerCase().includes(q) ||
      s.hint.toLowerCase().includes(q),
  );
}

/**
 * Append a focus-source scope note to a request, mirroring the guided-setup
 * fold. Matter scoping is real (matter_id reaches the orchestrator), but there
 * is no backend document-set field, so chosen documents are surfaced to the
 * model as an attention (or strict) hint in the request text.
 */
export function appendSourceScope(
  text: string,
  matter: MatterScope | null,
  selectedDocs: SelectedDoc[],
  focusOnly: boolean,
): string {
  if (!selectedDocs.length) return text.trim();
  const titles = selectedDocs.map((d) => `“${d.title}”`).join(", ");
  const where = matter?.label ? ` from the ${matter.label} file` : "";
  const note = focusOnly
    ? ` Base the analysis strictly on these documents${where}: ${titles}.`
    : ` Give particular attention to these documents${where}: ${titles}.`;
  return `${text}${note}`.replace(/\s+/g, " ").trim();
}

export function composeSkill(skill: ResearchSkill, values: Record<string, string>): string | null {
  for (const field of skill.fields) {
    if (field.required && !v(values, field.id)) return null;
  }
  return skill.compose(values).replace(/\s+/g, " ").trim();
}

/** Seed a skill's values so every `select` field starts on its first option. */
export function initialSkillValues(skill: ResearchSkill): Record<string, string> {
  const init: Record<string, string> = {};
  for (const field of skill.fields) {
    if (field.kind === "select" && field.options?.[0]) init[field.id] = field.options[0].id;
  }
  return init;
}

/** True when the composer text is a slash command still being typed. */
export function slashDraft(text: string): string | null {
  if (!text.startsWith("/")) return null;
  if (/\s/.test(text)) return null;
  return text.slice(1);
}
