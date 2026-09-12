import type { AppTemplate } from "./app-templates";
import type { AppField } from "./types";

export const firmRoles = [
  "Leadership",
  "Litigating attorney",
  "Research attorney",
  "Litigation paralegal",
  "Managing clerk / MCO",
  "Case manager",
  "Intake specialist",
  "Client liaison",
  "Medical records analyst",
  "Discovery / litigation support",
  "Expert coordinator",
  "Trial team",
  "Settlement administrator",
  "Finance / operations",
  "Knowledge management",
];
export const litigationStages = [
  "Intake",
  "Case management",
  "Discovery",
  "Experts",
  "Motions",
  "Trial",
  "Settlement",
  "Firm operations",
];
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
const fjc = "https://www.fjc.gov/subject/multidistrict-litigation-mdl";
const civil =
  "https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure";
const edrm = "https://edrm.net/edrm-model/current/";
const nala = "https://nala.org/what-do-paralegals-do/";
const inputField = (id: string, label: string, type: AppField["type"], value = ""): AppField => ({
  id,
  label,
  type,
  value,
  required: false,
});
type Definition = {
  id: string;
  name: string;
  description: string;
  roles: string[];
  stage: string;
  recipe: string;
  input: string;
  output: string;
  requirements?: string[];
  profile?: string;
  terms?: string;
  source?: string;
  reviewer?: string;
  cadence?: string;
  boundary?: string;
  checks?: string[];
};
const definitions: Definition[] = [
  {
    id: "pfs-completeness",
    name: "Plaintiff fact-sheet completeness",
    description:
      "Check each fact sheet for required labels, blanks and conflicting answers before deficiency follow-up.",
    roles: ["Litigation paralegal", "Case manager", "Intake specialist"],
    stage: "Intake",
    recipe: "completeness",
    input: "One labeled fact sheet per plaintiff",
    output: "Per-client deficiency working list",
    requirements: [
      "Client ID",
      "Plaintiff",
      "Product",
      "Exposure start",
      "Injury",
      "Treating provider",
      "Signature",
      "Supporting records",
    ],
    source: fjc,
    checks: [
      "Use the actual court-approved fact sheet and amendment history.",
      "Verify signed originals and supporting records.",
      "Confirm the responsible case team before follow-up.",
    ],
  },
  {
    id: "intake-packet-audit",
    name: "New-client intake packet audit",
    description:
      "Find unresolved engagement, contact and records-authorization fields without making an eligibility decision.",
    roles: ["Intake specialist", "Case manager", "Litigation paralegal"],
    stage: "Intake",
    recipe: "completeness",
    input: "Labeled intake packet or intake export",
    output: "Missing-item intake checklist",
    requirements: [
      "Client ID",
      "Client name",
      "Contact preference",
      "Engagement status",
      "Conflict review",
      "Product",
      "Incident date",
      "Records authorization",
    ],
    source: nala,
  },
  {
    id: "exposure-reconciliation",
    name: "Exposure facts reconciliation",
    description:
      "Compare product, exposure date and provider values only within the same explicit client ID.",
    roles: ["Case manager", "Medical records analyst", "Litigating attorney"],
    stage: "Intake",
    recipe: "reconciliation",
    input: "Two or more labeled records with Client ID",
    output: "Source-by-source conflict register",
    requirements: ["Product", "Exposure date", "Provider"],
    source: fjc,
    checks: [
      "Confirm that Client ID is unique and present in each document.",
      "Resolve conflicting values against the complete original.",
      "Record who made the reconciliation decision.",
    ],
  },
  {
    id: "medical-request-tracker",
    name: "Medical-record request tracker",
    description:
      "Review receipt gaps, duplicate provider requests and malformed request dates from a records log.",
    roles: ["Medical records analyst", "Litigation paralegal", "Case manager"],
    stage: "Discovery",
    recipe: "register",
    profile: "medical",
    input: "CSV: Client ID, Provider, Requested, Received, Owner",
    output: "Records follow-up queue",
    source: nala,
  },
  {
    id: "medical-bundle-quality",
    name: "Medical-record bundle quality",
    description:
      "Inspect text coverage and duplicate source material before creating a medical chronology.",
    roles: ["Medical records analyst", "Discovery / litigation support"],
    stage: "Discovery",
    recipe: "sourceqc",
    input: "A batch of source documents",
    output: "Read-coverage and duplicate report",
    source: edrm,
    boundary:
      "Does not determine medical completeness, diagnosis or causation; inspect image-only pages and original records.",
  },
  {
    id: "client-contact-prep",
    name: "Client-contact preparation",
    description:
      "Gather approved wording, outstanding items and contact preferences before a case-team follow-up.",
    roles: ["Client liaison", "Case manager", "Intake specialist"],
    stage: "Case management",
    recipe: "completeness",
    input: "One labeled client contact note per file",
    output: "Contact preparation checklist",
    requirements: [
      "Client ID",
      "Last contact",
      "Contact preference",
      "Outstanding item",
      "Next action",
      "Assigned owner",
      "Approved message",
    ],
    source: nala,
    boundary:
      "Prepares internal notes only. Does not contact clients or turn unapproved legal advice into a message.",
  },
  {
    id: "cmo-obligations",
    name: "Case-management order obligations",
    description:
      "Collect express obligations, dates and relative triggers for independent docketing verification.",
    roles: ["Managing clerk / MCO", "Litigation paralegal", "Litigating attorney"],
    stage: "Case management",
    recipe: "obligations",
    input: "Signed order or CMO with readable text",
    output: "Order obligation review register",
    source: civil,
    reviewer: "Managing clerk and responsible attorney",
    boundary:
      "No deadline calculation. Review service, trigger, amended orders, jurisdiction, holidays and timezone before calendaring.",
  },
  {
    id: "service-return-check",
    name: "Service-return packet check",
    description:
      "Flag missing service-method, return and docket-reference labels for the managing clerk.",
    roles: ["Managing clerk / MCO", "Litigation paralegal"],
    stage: "Case management",
    recipe: "completeness",
    input: "Labeled service record and return inventory",
    output: "Service verification worksheet",
    requirements: [
      "Matter",
      "Party served",
      "Method of service",
      "Service date",
      "Return or waiver",
      "Docket reference",
      "Verifier",
    ],
    source: civil,
    boundary:
      "A source label does not prove valid service. Counsel must verify method, recipient and applicable rules.",
  },
  {
    id: "filing-packet-preflight",
    name: "Filing-packet preflight",
    description:
      "Check the filing worksheet for signature, service, exhibits, redaction and local-rule review status.",
    roles: ["Managing clerk / MCO", "Litigation paralegal", "Litigating attorney"],
    stage: "Motions",
    recipe: "completeness",
    input: "Labeled filing checklist; inspect original documents separately",
    output: "Pre-filing exception list",
    requirements: [
      "Court",
      "Case number",
      "Document title",
      "Signature block",
      "Certificate of service",
      "Exhibit index",
      "Redaction review",
      "Local rule check",
    ],
    source: civil,
    boundary:
      "Checks the worksheet, not court compliance. Does not validate fonts, pagination, redactions or file through ECF.",
  },
  {
    id: "docket-team-handoff",
    name: "Docket-to-team handoff",
    description:
      "Turn express docket and order action language into a source-linked queue for team assignment.",
    roles: ["Managing clerk / MCO", "Case manager", "Litigation paralegal"],
    stage: "Case management",
    recipe: "obligations",
    input: "Downloaded docket entries and attached orders",
    output: "Action and trigger handoff register",
    source: fjc,
  },
  {
    id: "leadership-status",
    name: "Leadership case-status review",
    description:
      "Review ownership, missing next steps and overdue register items across a matter portfolio.",
    roles: ["Leadership", "Case manager", "Litigating attorney"],
    stage: "Case management",
    recipe: "register",
    profile: "case",
    input: "CSV: Matter, Owner, Status, Next action, Due date",
    output: "Portfolio exception briefing",
    source: fjc,
    cadence: "Before a leadership or steering-committee meeting",
  },
  {
    id: "bellwether-readiness",
    name: "Bellwether file readiness",
    description:
      "Review the availability of core case materials before counsel evaluates a candidate file.",
    roles: ["Leadership", "Litigating attorney", "Case manager", "Trial team"],
    stage: "Trial",
    recipe: "completeness",
    input: "One labeled candidate-file inventory per client",
    output: "Readiness gaps by candidate",
    requirements: [
      "Client ID",
      "Complaint",
      "Fact sheet",
      "Product identification",
      "Medical record index",
      "Deposition",
      "Expert materials",
      "Outstanding discovery",
      "Client availability",
    ],
    source: fjc,
    boundary:
      "A file-readiness checklist, not a ranking of plaintiffs, assessment of representativeness or bellwether selection decision.",
  },
  {
    id: "common-benefit-time",
    name: "Common-benefit time quality review",
    description:
      "Check time exports for duplicate entries, date and hour errors, vague descriptions and allowed task codes.",
    roles: ["Finance / operations", "Leadership", "Litigating attorney"],
    stage: "Firm operations",
    recipe: "timeqc",
    input: "CSV: Date, Timekeeper, Matter, Hours, Task code, Description",
    output: "Time-entry correction queue",
    source: fjc,
    reviewer: "Timekeeper and common-benefit administrator",
    boundary:
      "Use the actual timekeeping order and approved codes. Mechanical checks do not establish compensability or approval.",
  },
  {
    id: "case-team-work-queue",
    name: "Case-team work queue",
    description:
      "Find unassigned matters, missing next actions and unresolved due dates in a team handoff export.",
    roles: ["Case manager", "Litigation paralegal", "Leadership"],
    stage: "Case management",
    recipe: "register",
    profile: "case",
    input: "CSV: Matter, Owner, Status, Next action, Due date",
    output: "Owner and next-action exception queue",
    source: nala,
  },
  {
    id: "deposition-qa-binder",
    name: "Deposition Q&A topic binder",
    description:
      "Collect complete question-and-answer blocks by topic, retaining objections and qualifications.",
    roles: ["Litigating attorney", "Litigation paralegal", "Trial team"],
    stage: "Discovery",
    recipe: "testimony",
    input: "Transcript with Q./A. markers and page labels",
    output: "Topic binder with full Q&A context",
    terms: "notice, warning, injury",
    source: nala,
    checks: [
      "Verify speaker identity in the full transcript.",
      "Retain uncertainty, objections and qualifications.",
      "Confirm printed page:line cites before using a quotation.",
    ],
  },
  {
    id: "deposition-exhibit-map",
    name: "Deposition exhibit reference map",
    description:
      "Index references to exhibits across transcripts for source-document retrieval and preparation.",
    roles: ["Litigation paralegal", "Litigating attorney", "Trial team"],
    stage: "Discovery",
    recipe: "exhibits",
    input: "One or more deposition transcripts",
    output: "Exhibit mention and source-page index",
    source: nala,
  },
  {
    id: "expert-disclosure-audit",
    name: "Expert disclosure packet audit",
    description:
      "Review the reported presence of opinions, data, exhibits, qualifications and other packet components.",
    roles: ["Expert coordinator", "Litigating attorney", "Litigation paralegal"],
    stage: "Experts",
    recipe: "completeness",
    input: "Labeled expert packet inventory",
    output: "Disclosure preparation checklist",
    requirements: [
      "Expert name",
      "Opinions",
      "Facts or data considered",
      "Exhibits",
      "Qualifications",
      "Publications",
      "Prior testimony",
      "Compensation",
    ],
    source: civil,
    boundary:
      "Adapt to the governing rule, witness category and court order. Does not decide disclosure sufficiency or waive protected material.",
  },
  {
    id: "expert-methodology-evidence",
    name: "Expert methodology evidence packet",
    description:
      "Locate passages about methodology, limitations and alternative explanations for counsel's review.",
    roles: ["Expert coordinator", "Litigating attorney", "Research attorney"],
    stage: "Experts",
    recipe: "issues",
    input: "Readable expert report and selected supporting materials",
    output: "Methodology passage matrix",
    terms: "methodology, limitations, alternative explanations, causation",
    source: civil,
    boundary:
      "Topic retrieval only; no scientific validity, medical causation or admissibility conclusion.",
  },
  {
    id: "discovery-deficiency-list",
    name: "Discovery deficiency working list",
    description:
      "Keep numbered requests and their response blocks together for a meet-and-confer review.",
    roles: ["Litigation paralegal", "Litigating attorney", "Discovery / litigation support"],
    stage: "Discovery",
    recipe: "requests",
    input: "Numbered requests followed by responses",
    output: "Request, response and objection review list",
    source: civil,
    boundary:
      "Does not determine whether a response or objection is legally sufficient. Confirm production against the actual request and agreement.",
  },
  {
    id: "privilege-log-qc",
    name: "Privilege-log quality review",
    description:
      "Check a log export for missing metadata and duplicate document IDs before attorney review.",
    roles: ["Discovery / litigation support", "Litigating attorney", "Litigation paralegal"],
    stage: "Discovery",
    recipe: "register",
    profile: "privilege",
    input: "CSV: Document ID, Date, Author, Recipients, Privilege basis, Description",
    output: "Privilege-log metadata exceptions",
    source: civil,
    boundary:
      "Field presence is not a privilege determination. Apply the governing log protocol and counsel's privilege analysis.",
  },
  {
    id: "production-index-qc",
    name: "Production index quality review",
    description:
      "Flag missing custodians, duplicate document IDs and inconsistent Bates ranges in a production index.",
    roles: ["Discovery / litigation support", "Litigation paralegal"],
    stage: "Discovery",
    recipe: "register",
    profile: "production",
    input: "CSV: Document ID, Bates start, Bates end, Custodian, Confidentiality",
    output: "Production handoff exceptions",
    source: edrm,
    boundary:
      "Checks index values only. Does not verify native-file delivery, family completeness, redactions or the content of produced documents.",
  },
  {
    id: "hold-acknowledgment-review",
    name: "Preservation acknowledgment review",
    description:
      "Identify unresolved acknowledgments and owner gaps from a supplied custodian notice log.",
    roles: ["Discovery / litigation support", "Case manager", "Litigating attorney"],
    stage: "Discovery",
    recipe: "register",
    profile: "hold",
    input: "CSV: Custodian, Notice date, Acknowledged, Owner",
    output: "Preservation follow-up working list",
    source: edrm,
    boundary:
      "No legal hold is issued or released. Counsel decides preservation scope, notices and escalation.",
  },
  {
    id: "protective-order-obligations",
    name: "Protective-order obligation register",
    description:
      "Collect express handling, disclosure and return obligations for a document-handling playbook.",
    roles: ["Discovery / litigation support", "Litigating attorney", "Case manager"],
    stage: "Discovery",
    recipe: "obligations",
    input: "Readable protective order and amendments",
    output: "Source-linked handling obligations",
    source: civil,
  },
  {
    id: "trial-exhibit-references",
    name: "Trial exhibit reference review",
    description:
      "Collect explicit exhibit references in preparation notes and testimony for exhibit-team verification.",
    roles: ["Trial team", "Litigation paralegal", "Litigating attorney"],
    stage: "Trial",
    recipe: "exhibits",
    input: "Trial notes, draft examinations or transcripts",
    output: "Exhibit reference checklist",
    source: nala,
    boundary:
      "Does not determine admissibility, foundation or admission status. Verify each exhibit against the court's actual exhibit record.",
  },
  {
    id: "trial-witness-readiness",
    name: "Trial witness readiness",
    description:
      "Review witness availability, topic plans, exhibit lists and open preparation questions.",
    roles: ["Trial team", "Litigation paralegal", "Litigating attorney"],
    stage: "Trial",
    recipe: "completeness",
    input: "One labeled witness preparation sheet per file",
    output: "Witness preparation gaps",
    requirements: [
      "Witness",
      "Contact owner",
      "Availability",
      "Testimony topics",
      "Exhibit list",
      "Prior testimony",
      "Open questions",
      "Attorney review",
    ],
    source: nala,
  },
  {
    id: "motion-record-matrix",
    name: "Motion record evidence matrix",
    description:
      "Collect source passages for a motion issue list and preserve qualifications beside each match.",
    roles: ["Litigating attorney", "Research attorney", "Litigation paralegal"],
    stage: "Motions",
    recipe: "issues",
    input: "Selected record documents plus an issue list",
    output: "Issue-to-record working matrix",
    terms: "notice, warning, retention, causation",
    source: civil,
    boundary:
      "Retrieves issue terms, not proven propositions. Counsel must assess relevance, admissibility and the entire context.",
  },
  {
    id: "research-authority-packet",
    name: "Research authority reading packet",
    description:
      "Organize supplied opinions, rules and research materials into an issue-based reading packet.",
    roles: ["Research attorney", "Litigating attorney", "Knowledge management"],
    stage: "Motions",
    recipe: "researchpacket",
    input: "Downloaded authorities or pasted primary-source text",
    output: "Reading packet and verification questions",
    terms: "discovery, preservation, plaintiff fact sheet",
    source: civil,
    boundary:
      "Does not search subscription databases or produce a legal answer. Use Public research brief for web leads, then verify the original authorities.",
  },
  {
    id: "brief-quotation-verification",
    name: "Brief quotation source check",
    description: "Compare quotation candidates in a draft with the source documents you supply.",
    roles: ["Research attorney", "Litigating attorney", "Litigation paralegal"],
    stage: "Motions",
    recipe: "quotations",
    input: "Draft first, then actual source authorities",
    output: "Quotation matches and review exceptions",
    source: civil,
    boundary:
      "Text matching does not establish legal accuracy, attribution, precedential weight or current validity. Review ellipses, brackets and line wrapping.",
  },
  {
    id: "settlement-packet-readiness",
    name: "Settlement packet readiness",
    description:
      "Review release, approval, lien and payment-verification status before settlement administration.",
    roles: ["Settlement administrator", "Case manager", "Litigating attorney"],
    stage: "Settlement",
    recipe: "completeness",
    input: "One labeled settlement checklist per client",
    output: "Settlement completion exceptions",
    requirements: [
      "Client ID",
      "Release",
      "Client approval",
      "Lien review",
      "Allocation worksheet",
      "Tax form status",
      "Payment instructions verification",
      "Attorney approval",
    ],
    source: fjc,
    boundary:
      "No release interpretation, allocation, tax advice or payment authorization. Verify payment instructions independently in the approved process.",
  },
  {
    id: "lien-followup-register",
    name: "Lien follow-up register",
    description:
      "Review claimed-amount fields, owners and duplicate lienholder records before counsel's resolution work.",
    roles: ["Settlement administrator", "Case manager", "Finance / operations"],
    stage: "Settlement",
    recipe: "register",
    profile: "lien",
    input: "CSV: Client ID, Lienholder, Claimed amount, Status, Owner",
    output: "Lien resolution follow-up queue",
    source: fjc,
    boundary:
      "Claimed amounts are not final liens. No entitlement, priority, reduction or Medicare reporting determination is made.",
  },
  {
    id: "settlement-arithmetic",
    name: "Settlement arithmetic worksheet",
    description:
      "Reconcile entered gross amounts and deductions with exact-cent arithmetic and exception flags.",
    roles: ["Settlement administrator", "Finance / operations", "Litigating attorney"],
    stage: "Settlement",
    recipe: "settlementmath",
    input: "CSV: Client ID, Gross, Fees, Expenses, Liens (USD)",
    output: "Illustrative net and exception worksheet",
    source: fjc,
    reviewer: "Responsible attorney and settlement finance reviewer",
    boundary:
      "An arithmetic aid only. Fees and deductions are inputs, not approved entitlements. Does not allocate settlement funds, authorize payments or provide tax advice.",
  },
  {
    id: "precedent-library-intake",
    name: "Precedent library intake",
    description:
      "Check reusable material for source ownership, jurisdiction, currency and permission-to-reuse fields.",
    roles: ["Knowledge management", "Research attorney", "Litigation paralegal"],
    stage: "Firm operations",
    recipe: "completeness",
    input: "Labeled precedent cover sheet",
    output: "Knowledge-library intake exceptions",
    requirements: [
      "Title",
      "Jurisdiction",
      "Matter",
      "Document date",
      "Source owner",
      "Permission to reuse",
      "Confidentiality review",
      "Currency review",
    ],
    source: nala,
    boundary:
      "Metadata completeness is not permission to reuse. Confirm confidentiality, privilege and currency with the material's owner.",
  },
];
export const practiceTemplates: AppTemplate[] = definitions.map((d) => ({
  id: d.id,
  name: d.name,
  description: d.description,
  category: d.stage,
  icon:
    d.recipe === "register"
      ? "Table2"
      : d.recipe === "completeness"
        ? "ClipboardCheck"
        : d.stage === "Settlement"
          ? "Calculator"
          : d.recipe === "obligations"
            ? "CalendarClock"
            : "FileSearch",
  tone: d.stage === "Settlement" ? "amber" : "blue",
  recipe: d.recipe,
  input: d.input,
  output: d.output,
  mode: "Local",
  source: d.source || fjc,
  fields: [
    ...(d.requirements
      ? [
          inputField(
            "requirements",
            "Required labels / fields",
            "textarea",
            d.requirements.join("\n"),
          ),
        ]
      : []),
    ...(d.recipe === "reconciliation"
      ? [inputField("identity", "Record identity label", "text", "Client ID")]
      : []),
    ...(d.terms
      ? [inputField("issues", "Issue terms (one per line or comma)", "textarea", d.terms)]
      : []),
    ...(d.profile === "case"
      ? [inputField("asof", "As-of date for open-item review", "date")]
      : []),
    ...(d.recipe === "timeqc"
      ? [inputField("codes", "Approved task codes (from your order)", "text", "DOC, DEP, RES")]
      : []),
  ],
  config: {
    value: d.profile,
    fields: d.requirements,
    query: d.terms,
    instructions: `Purpose: ${d.description}\nWork only from supplied documents. Preserve client identity, source IDs, page and extracted-line references and exact quotations. Distinguish missing information from a negative answer. Do not resolve conflicting facts or infer legal conclusions. ${d.boundary || "Apply the actual matter-specific requirements and have the responsible professional review the result."}`,
  },
  guide: {
    roles: d.roles,
    stage: d.stage,
    inputGuide: d.input,
    process: [
      "Collect the documents listed in the input requirements.",
      "Review matter-specific document coverage and required fields.",
      `Run the analysis to create the ${d.output.toLowerCase()}.`,
      `Have ${d.reviewer || "the responsible attorney or case-team reviewer"} resolve exceptions before exporting or acting.`,
    ],
    reviewChecks: d.checks || [
      "Confirm the right matter, client and current source version.",
      "Inspect every missing, conflicting or flagged value against the original.",
      "Apply the actual case order or approved firm playbook; record the review decision.",
    ],
    reviewer: d.reviewer || "Responsible attorney or designated case-team reviewer",
    cadence: d.cadence || "On new or updated matter documents",
    boundary:
      d.boundary ||
      "Local working paper with explicit-text and metadata checks. Legal interpretation and final decisions remain with the responsible professional.",
  },
}));
export function baseTemplateGuide(id: string, category: string, input: string): TemplateGuide {
  const roles =
    category === "Drafting"
      ? ["Litigating attorney", "Research attorney", "Litigation paralegal"]
      : category === "Email & meetings"
        ? ["Case manager", "Client liaison", "Leadership"]
        : category === "Research"
          ? ["Research attorney", "Knowledge management"]
          : category === "Intake & operations"
            ? ["Litigation paralegal", "Discovery / litigation support", "Managing clerk / MCO"]
            : ["Litigating attorney", "Litigation paralegal", "Case manager"];
  if (id === "treatment-timeline") roles.push("Medical records analyst");
  return {
    roles,
    stage:
      category === "Drafting"
        ? "Motions"
        : category === "Email & meetings"
          ? "Case management"
          : category === "Intake & operations"
            ? "Firm operations"
            : "Discovery",
    inputGuide: input,
    process: [
      "Inspect the required input format and source coverage.",
      "Load your sources and configure the available fields.",
      "Review the source excerpts and scope notes, then export the working paper.",
    ],
    reviewChecks: [
      "Verify source identity and read coverage.",
      "Inspect the original before relying on a finding.",
      "Use a connected approved model for semantic work beyond the stated local recipe.",
    ],
    reviewer: "Responsible attorney or case-team reviewer",
    cadence: "On demand or after updated source material",
    boundary:
      "Local capabilities are described in the app. Use configured server services for account access and scheduling. Legal conclusions require review; email delivery is not enabled.",
  };
}
