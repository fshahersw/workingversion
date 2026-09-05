// ============================================================================
// Review Tables — one-click column packs.
//
// Pure data. Each pack is a list of grounded questions with an answer type,
// written so the model can answer from a single document and cite a page.
// ============================================================================
import type { ColumnKind } from "./types";

export type TemplateColumn = {
  name: string;
  kind: ColumnKind;
  question: string;
  options?: string[];
};

export type ColumnTemplate = {
  id: string;
  name: string;
  blurb: string;
  columns: TemplateColumn[];
};

const YES_NO = "Answer Yes, No, or Unclear.";

export const COLUMN_TEMPLATES: ColumnTemplate[] = [
  {
    id: "contract",
    name: "Contract review",
    blurb: "Commercial terms, risk allocation and dispute clauses.",
    columns: [
      { name: "Parties", kind: "list", question: "Name every party to this agreement exactly as written in the document." },
      { name: "Agreement type", kind: "text", question: "What type of agreement is this (e.g. MSA, NDA, license, employment)?" },
      { name: "Effective date", kind: "date", question: "What is the effective date of this agreement?" },
      { name: "Term / expiration", kind: "text", question: "What is the initial term and expiration date of the agreement?" },
      { name: "Renewal", kind: "text", question: "How does the agreement renew (auto-renew, renewal term, notice to prevent renewal)?" },
      { name: "Governing law", kind: "text", question: "What jurisdiction's law governs this agreement? Answer with the state or country only." },
      { name: "Venue / forum", kind: "text", question: "What court, venue or forum is designated for disputes?" },
      { name: "Arbitration", kind: "yes_no", question: `Does the agreement require arbitration of disputes? ${YES_NO}` },
      { name: "Class waiver", kind: "yes_no", question: `Does the agreement waive class or collective actions? ${YES_NO}` },
      { name: "Assignment / change of control", kind: "long_text", question: "What does the agreement say about assignment and change of control?" },
      { name: "Indemnity", kind: "long_text", question: "Who indemnifies whom, and for what categories of claims?" },
      { name: "Limitation of liability", kind: "long_text", question: "Summarize the limitation of liability clause, including any exclusions." },
      { name: "Liability cap", kind: "text", question: "What is the monetary cap on liability, including how it is calculated?" },
      { name: "Warranties", kind: "long_text", question: "What warranties are given, and are any expressly disclaimed?" },
      { name: "Confidentiality", kind: "yes_no", question: `Does the agreement contain a confidentiality obligation? ${YES_NO}` },
      { name: "Confidentiality term", kind: "text", question: "How long do the confidentiality obligations last?" },
      { name: "Termination for convenience", kind: "text", question: "May a party terminate for convenience, and on what notice?" },
      { name: "Notice period", kind: "text", question: "What notice period is required for termination or breach cure?" },
      { name: "Payment terms", kind: "text", question: "What are the payment terms (amounts, schedule, invoicing, late fees)?" },
      { name: "Fees / pricing", kind: "text", question: "What fees or pricing does the agreement state?" },
      { name: "Exclusivity", kind: "yes_no", question: `Does the agreement grant exclusivity to any party? ${YES_NO}` },
      { name: "Non-compete / non-solicit", kind: "long_text", question: "Describe any non-compete or non-solicitation restriction, including scope and duration." },
      { name: "Insurance", kind: "text", question: "What insurance coverage and limits are required?" },
      { name: "Signatories", kind: "list", question: "List the signatories and their titles as shown in the signature block." },
    ],
  },
  {
    id: "privilege",
    name: "Privilege & responsiveness pass",
    blurb: "First-pass review calls for a production set.",
    columns: [
      {
        name: "Privilege call",
        kind: "select",
        options: ["Privileged", "Partially privileged", "Not privileged", "Unclear"],
        question: "Based only on this document, is it privileged, partially privileged, not privileged, or unclear?",
      },
      { name: "Privilege basis", kind: "text", question: "If privilege is asserted, what is the basis (attorney-client, work product, common interest)?" },
      { name: "Attorneys named", kind: "list", question: "List every attorney or law firm named in this document." },
      { name: "Client / party", kind: "list", question: "Which client or party does this document belong to or concern?" },
      { name: "Work product", kind: "yes_no", question: `Was this document prepared in anticipation of litigation? ${YES_NO}` },
      { name: "Document type", kind: "text", question: "What type of document is this (email, memo, contract, invoice, report, chat)?" },
      { name: "Document date", kind: "date", question: "What is the date of this document?" },
      { name: "Author", kind: "text", question: "Who authored or sent this document?" },
      { name: "Recipients", kind: "list", question: "List the recipients, including cc and bcc if shown." },
      { name: "Custodian", kind: "text", question: "What custodian or source is identified for this document?" },
      { name: "Confidentiality designation", kind: "text", question: "What confidentiality designation or legend appears on the document?" },
      { name: "PII / PHI present", kind: "yes_no", question: `Does the document contain personal or health information (SSN, DOB, medical detail, financial account)? ${YES_NO}` },
      { name: "Redactions needed", kind: "long_text", question: "What content, if any, would need redaction before production, and on what page?" },
      { name: "Responsiveness", kind: "select", options: ["Responsive", "Not responsive", "Unclear"], question: "Is this document responsive to a document request about the subject matter of the case?" },
      { name: "Key issue", kind: "long_text", question: "What is the single most significant fact or issue this document establishes?" },
    ],
  },
  {
    id: "deposition",
    name: "Deposition / transcript intake",
    blurb: "Triage a set of transcripts before detailed analysis.",
    columns: [
      { name: "Deponent", kind: "text", question: "Who is the deponent or witness?" },
      { name: "Role", kind: "text", question: "What is the deponent's role, title or relationship to the parties?" },
      { name: "Deposition date", kind: "date", question: "On what date was this testimony taken?" },
      { name: "Examining counsel", kind: "list", question: "Which attorneys examined the witness?" },
      { name: "Key admissions", kind: "long_text", question: "What admissions against interest did the witness make?" },
      { name: "Key concessions", kind: "long_text", question: "What concessions or qualifications did the witness make about their own knowledge?" },
      { name: "Exhibits referenced", kind: "list", question: "List the exhibit numbers referenced in the testimony." },
      { name: "Objections", kind: "long_text", question: "What objections were made and on what grounds?" },
      { name: "Privilege instructions", kind: "yes_no", question: `Was the witness instructed not to answer on privilege grounds? ${YES_NO}` },
      { name: "Expert opinions", kind: "long_text", question: "What opinions, if any, did the witness offer, and on what basis?" },
      { name: "Dates discussed", kind: "list", question: "List the specific dates the witness testified about." },
      { name: "Entities named", kind: "list", question: "List the companies or entities the witness named." },
      { name: "Follow-up needed", kind: "long_text", question: "What testimony is incomplete or warrants follow-up discovery?" },
    ],
  },
  {
    id: "medical",
    name: "Medical records / injury",
    blurb: "Personal injury and mass tort record abstraction.",
    columns: [
      { name: "Patient", kind: "text", question: "Who is the patient named in this record?" },
      { name: "Provider", kind: "text", question: "What provider or facility created this record?" },
      { name: "Encounter date", kind: "date", question: "What is the date of the encounter or service?" },
      { name: "Chief complaint", kind: "text", question: "What is the chief complaint or reason for the visit?" },
      { name: "Diagnoses", kind: "list", question: "List the diagnoses stated, including ICD codes if shown." },
      { name: "Injury described", kind: "long_text", question: "How is the injury or condition described?" },
      { name: "Causation statements", kind: "long_text", question: "Does any provider state a cause or mechanism for the condition? Quote it." },
      { name: "Prior conditions", kind: "long_text", question: "What pre-existing or prior conditions are documented?" },
      { name: "Treatment plan", kind: "long_text", question: "What treatment was provided or planned?" },
      { name: "Imaging / testing", kind: "list", question: "List the imaging studies or diagnostic tests referenced and their findings." },
      { name: "Medications", kind: "list", question: "List the medications prescribed or documented, with dosage if given." },
      { name: "Work restrictions", kind: "text", question: "What work or activity restrictions were imposed?" },
      { name: "Disability duration", kind: "text", question: "For how long was the patient disabled or restricted?" },
      { name: "Billed amount", kind: "number", question: "What total amount was billed? Keep the currency." },
      { name: "Paid amount", kind: "number", question: "What amount was paid or adjusted? Keep the currency." },
      { name: "Referrals", kind: "list", question: "What referrals to other providers or specialists are documented?" },
      { name: "Discharge date", kind: "date", question: "What is the discharge or last-treatment date in this record?" },
    ],
  },
  {
    id: "diligence",
    name: "Corporate / due diligence",
    blurb: "Entity, ownership, obligation and exposure facts.",
    columns: [
      { name: "Entity name", kind: "text", question: "What entity is the subject of this document?" },
      { name: "Jurisdiction", kind: "text", question: "In what jurisdiction is the entity organized?" },
      { name: "Formation date", kind: "date", question: "When was the entity formed or incorporated?" },
      { name: "Officers", kind: "list", question: "List the officers named and their titles." },
      { name: "Directors", kind: "list", question: "List the directors or managers named." },
      { name: "Ownership", kind: "long_text", question: "Describe the ownership or capitalization stated in this document." },
      { name: "Subsidiaries / affiliates", kind: "list", question: "List the subsidiaries or affiliated entities named." },
      { name: "Litigation disclosed", kind: "long_text", question: "What litigation, claims or investigations are disclosed?" },
      { name: "Liens / encumbrances", kind: "long_text", question: "What liens, security interests or encumbrances are described?" },
      { name: "Licenses / permits", kind: "list", question: "What licenses or permits are identified?" },
      { name: "Regulatory approvals", kind: "long_text", question: "What regulatory approvals or consents are required or obtained?" },
      { name: "Related-party transactions", kind: "long_text", question: "What related-party or affiliate transactions are disclosed?" },
      { name: "Financial statements", kind: "text", question: "What financial statements or periods does this document reference?" },
      { name: "Revenue", kind: "number", question: "What revenue figure is stated, and for what period? Keep the currency." },
      { name: "Debt obligations", kind: "long_text", question: "What debt, credit facilities or payment obligations are described?" },
      { name: "Insurance policies", kind: "list", question: "What insurance policies, carriers or limits are identified?" },
      { name: "IP assets", kind: "list", question: "What intellectual property (patents, marks, registrations) is identified?" },
      { name: "Employee count", kind: "number", question: "How many employees does the document state?" },
    ],
  },
  {
    id: "filings",
    name: "Court filings / docket",
    blurb: "Abstract a set of briefs, motions and orders.",
    columns: [
      { name: "Filing type", kind: "text", question: "What type of filing is this (complaint, motion, opposition, order, notice)?" },
      { name: "Filing party", kind: "text", question: "Which party filed this document?" },
      { name: "Court", kind: "text", question: "In what court was this filed?" },
      { name: "Judge", kind: "text", question: "What judge is identified on this filing?" },
      { name: "Case number", kind: "text", question: "What is the case or docket number?" },
      { name: "Date filed", kind: "date", question: "On what date was this filed or entered?" },
      { name: "Relief sought", kind: "long_text", question: "What relief does this filing request or grant?" },
      { name: "Legal claims", kind: "list", question: "What causes of action or legal claims are asserted?" },
      { name: "Statutes cited", kind: "list", question: "List the statutes or rules cited." },
      { name: "Key cases cited", kind: "list", question: "List the principal cases cited." },
      { name: "Opposing party", kind: "text", question: "Who is the opposing party addressed by this filing?" },
      { name: "Deadlines set", kind: "long_text", question: "What deadlines or response dates does this document set?" },
      { name: "Hearing date", kind: "date", question: "What hearing or conference date is set?" },
      { name: "Disposition", kind: "text", question: "If this is an order, what was granted, denied or held?" },
    ],
  },
];
