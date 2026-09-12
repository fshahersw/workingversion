// ============================================================================
// Document templates for the Office assistants (list_templates / apply_template
// / save_template). Two sources:
//   - built-in firm templates defined here, per editor kind
//   - templates the user saved from their own documents (DynamoDB rows under
//     PK=USER#<principal>, SK=TPL#<kind>#<id>)
// Payloads are editor-native so the browser applies them deterministically
// with the editor's own machinery, not by asking the model to retype them:
//   docx  -> { format: "html", html }            Writer parses the HTML fragment
//   xlsx  -> { format: "ops", operations[] }    Sheets runs the workbook DSL ops
//                                               ("{{sheetId}}" is replaced by the
//                                               active sheet id at apply time)
//   pptx  -> { format: "deck", deck }            Slides builds native slides with
//                                               its local library (TemplateDeck)
// Placeholders are written as [Bracketed Labels] so the model fills them in a
// second step from the user's facts.
// ============================================================================
import { ulid } from "ulid";

import { deleteItem, getItem, putItem, queryPrefix } from "@/lib/data/dynamo.server";

import { OfficeError } from "./office.server";

export type TemplateKind = "docx" | "xlsx" | "pptx";

export type TemplateSummary = {
  id: string;
  kind: TemplateKind;
  name: string;
  description: string;
  category: string;
  source: "firm" | "mine";
  createdAt?: string;
};

/** JSON-shaped template payload (editor-native: html / ops / deck). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type TemplateDetail = TemplateSummary & { payload: JsonValue };

const userPK = (p: string) => `USER#${p}`;
const tplSK = (kind: string, id: string) => `TPL#${kind}#${id}`;
const MAX_PAYLOAD_CHARS = 300_000;
const MAX_USER_TEMPLATES = 200;

function kindOf(v: unknown): TemplateKind {
  if (v === "docx" || v === "xlsx" || v === "pptx") return v;
  throw new OfficeError(422, "kind must be docx, xlsx or pptx.");
}

// --- Built-in library ---------------------------------------------------------------------

const S = "{{sheetId}}";
const HEADER_FILL = "#0F4A74";
const BAND_FILL = "#EFF4F7";

/** Shorthand for a header row + column widths + freeze, the frame every tracker shares. */
function sheetFrame(headers: string[], widths: number[], title?: string): JsonValue[] {
  const ops: JsonValue[] = [];
  const startRow = title ? 3 : 1;
  const lastCol = String.fromCharCode(64 + headers.length);
  if (title) {
    ops.push({ op: "set_cell", sheetId: S, address: "A1", value: title });
    ops.push({ op: "format_range", sheetId: S, range: "A1:A1", format: { bold: true, fontSize: 14, fontColor: HEADER_FILL } });
  }
  ops.push({ op: "set_range", sheetId: S, start: `A${startRow}`, values: [headers] });
  ops.push({
    op: "format_range",
    sheetId: S,
    range: `A${startRow}:${lastCol}${startRow}`,
    format: { bold: true, fillColor: HEADER_FILL, fontColor: "#FFFFFF", verticalAlign: "center", wrapText: true },
  });
  ops.push({ op: "set_row_height", sheetId: S, row: startRow, heightPoints: 28 });
  widths.forEach((w, i) => ops.push({ op: "set_col_width", sheetId: S, column: String.fromCharCode(65 + i), widthPx: w }));
  ops.push({ op: "set_freeze", sheetId: S, rows: startRow, columns: 0 });
  ops.push({ op: "format_range", sheetId: S, range: `A${startRow + 1}:${lastCol}${startRow + 40}`, format: { verticalAlign: "top", wrapText: true } });
  return ops;
}

const FIRM_TEMPLATES: TemplateDetail[] = [
  // ---------------------------------------------------------------- Writer (docx)
  {
    id: "legal-memorandum",
    kind: "docx",
    name: "Legal memorandum",
    category: "Memos",
    source: "firm",
    description: "Internal research memo: heading block, Question Presented, Brief Answer, Facts, Discussion, Conclusion.",
    payload: {
      format: "html",
      html: `<h1 style="text-align:center">MEMORANDUM</h1>
<p><strong>PRIVILEGED AND CONFIDENTIAL – ATTORNEY WORK PRODUCT</strong></p>
<table><tbody>
<tr><td><strong>TO:</strong></td><td>[Recipient]</td></tr>
<tr><td><strong>FROM:</strong></td><td>[Author]</td></tr>
<tr><td><strong>DATE:</strong></td><td>[Month Day, Year]</td></tr>
<tr><td><strong>RE:</strong></td><td>[Matter] – [Subject]</td></tr>
</tbody></table>
<h2>I. Question Presented</h2><p>[State the legal question in one or two sentences, including the governing jurisdiction.]</p>
<h2>II. Brief Answer</h2><p>[Answer directly: likely yes / likely no / uncertain, and the principal reason.]</p>
<h2>III. Statement of Facts</h2><p>[Facts relevant to the question, with record cites (Ex. A at 3; Smith Dep. 45:12-46:3).]</p>
<h2>IV. Discussion</h2><h3>A. [Governing standard]</h3><p>[Rule, with verified authority.]</p><h3>B. [Application]</h3><p>[Apply the rule to the facts; address the strongest counterargument.]</p>
<h2>V. Conclusion and Recommendation</h2><p>[Conclusion and next steps.]</p>`,
    },
  },
  {
    id: "client-letter",
    kind: "docx",
    name: "Client letter",
    category: "Correspondence",
    source: "firm",
    description: "Formal client letter on firm letterhead conventions: date, address block, Re line, body, closing.",
    payload: {
      format: "html",
      html: `<p>[Month Day, Year]</p>
<p><strong>VIA EMAIL</strong></p>
<p>[Client Name]<br/>[Address Line 1]<br/>[City, State ZIP]</p>
<p><strong>Re: [Matter Name] – [Subject]</strong></p>
<p>Dear [Salutation]:</p>
<p>[Purpose of the letter in one paragraph.]</p>
<p>[Background and status.]</p>
<p>[Recommendation or decision needed, with a date.]</p>
<p>Please do not hesitate to contact me with any questions.</p>
<p>Very truly yours,</p>
<p><br/>[Attorney Name]<br/>Seeger Weiss LLP</p>
<p>cc: [Names]</p>`,
    },
  },
  {
    id: "motion-brief",
    kind: "docx",
    name: "Motion / brief",
    category: "Court filings",
    source: "firm",
    description: "Caption, title, preliminary statement, statement of facts, legal standard, argument with point headings, conclusion, signature block.",
    payload: {
      format: "html",
      html: `<p style="text-align:center"><strong>UNITED STATES DISTRICT COURT<br/>[DISTRICT]</strong></p>
<table><tbody><tr><td>[PLAINTIFF],<br/><br/>Plaintiff,<br/><br/>v.<br/><br/>[DEFENDANT],<br/><br/>Defendant.</td><td>Civil Action No. [x:xx-cv-xxxxx]<br/><br/>[Hon. Judge Name]</td></tr></tbody></table>
<h1 style="text-align:center">[PLAINTIFF]'S MEMORANDUM OF LAW IN SUPPORT OF [MOTION]</h1>
<h2>PRELIMINARY STATEMENT</h2><p>[Why the motion should be granted, in one page.]</p>
<h2>STATEMENT OF FACTS</h2><p>[Facts with record citations (ECF No. __ at __).]</p>
<h2>LEGAL STANDARD</h2><p>[Governing rule and standard of review, with verified authority.]</p>
<h2>ARGUMENT</h2><h3>I. [POINT HEADING STATING THE CONCLUSION]</h3><p>[Argument.]</p><h3>II. [POINT HEADING]</h3><p>[Argument.]</p>
<h2>CONCLUSION</h2><p>For the foregoing reasons, [Plaintiff] respectfully requests that the Court [relief].</p>
<p>Dated: [Month Day, Year]<br/>[City, State]</p>
<p>Respectfully submitted,<br/><br/><strong>SEEGER WEISS LLP</strong><br/><br/>By: ______________________<br/>[Attorney Name]<br/>[Address]<br/>[Phone] | [Email]<br/><em>Attorneys for Plaintiff</em></p>`,
    },
  },
  {
    id: "deposition-summary",
    kind: "docx",
    name: "Deposition summary",
    category: "Discovery",
    source: "firm",
    description: "Page-line summary with key admissions, exhibits and follow-up items.",
    payload: {
      format: "html",
      html: `<h1>Deposition Summary – [Witness Name]</h1>
<table><tbody>
<tr><td><strong>Matter</strong></td><td>[Matter]</td></tr>
<tr><td><strong>Date of deposition</strong></td><td>[Date]</td></tr>
<tr><td><strong>Taken by / Defended by</strong></td><td>[Names]</td></tr>
<tr><td><strong>Role of witness</strong></td><td>[Party / employee / expert]</td></tr>
</tbody></table>
<h2>Key Admissions</h2><ul><li>[Admission] (Tr. 45:12-46:3)</li></ul>
<h2>Summary by Topic</h2><h3>[Topic 1]</h3><p>[Summary with page:line cites.]</p><h3>[Topic 2]</h3><p>[Summary.]</p>
<h2>Exhibits Marked</h2><table><thead><tr><th>Ex.</th><th>Description</th><th>Pages</th></tr></thead><tbody><tr><td>1</td><td>[Description]</td><td>[Tr. cite]</td></tr></tbody></table>
<h2>Credibility and Demeanor</h2><p>[Notes.]</p>
<h2>Follow-Up</h2><ul><li>[Document request / witness to depose / issue to research]</li></ul>`,
    },
  },
  {
    id: "case-timeline",
    kind: "docx",
    name: "Case chronology",
    category: "Case management",
    source: "firm",
    description: "Dated chronology table with source citations and significance column.",
    payload: {
      format: "html",
      html: `<h1>[Matter] – Chronology</h1>
<p><em>Prepared [Date]. Privileged and confidential.</em></p>
<table><thead><tr><th>Date</th><th>Event</th><th>Source</th><th>Significance</th></tr></thead>
<tbody><tr><td>[YYYY-MM-DD]</td><td>[Event]</td><td>[Ex. / Bates / Dep. cite]</td><td>[Why it matters]</td></tr></tbody></table>`,
    },
  },
  {
    id: "discovery-requests",
    kind: "docx",
    name: "Discovery requests",
    category: "Discovery",
    source: "firm",
    description: "Requests for production / interrogatories with definitions, instructions and numbered requests.",
    payload: {
      format: "html",
      html: `<p style="text-align:center"><strong>[COURT]</strong></p>
<h1 style="text-align:center">PLAINTIFF'S FIRST SET OF REQUESTS FOR PRODUCTION OF DOCUMENTS TO DEFENDANT [NAME]</h1>
<p>Pursuant to Rules 26 and 34 of the Federal Rules of Civil Procedure, Plaintiff requests that Defendant produce the following documents within thirty (30) days of service.</p>
<h2>DEFINITIONS</h2><ol><li>"Document" has the broadest meaning permitted under Rule 34(a) and includes electronically stored information.</li><li>"You" and "Your" mean [Defendant] and its officers, employees, agents and representatives.</li><li>"Relevant Period" means [dates].</li></ol>
<h2>INSTRUCTIONS</h2><ol><li>Produce documents as kept in the usual course of business or organized to correspond to these requests.</li><li>If any document is withheld under a claim of privilege, provide a privilege log compliant with Rule 26(b)(5).</li></ol>
<h2>REQUESTS FOR PRODUCTION</h2><p><strong>REQUEST NO. 1:</strong> [All documents concerning ...]</p><p><strong>REQUEST NO. 2:</strong> [...]</p>
<p>Dated: [Date]</p><p><strong>SEEGER WEISS LLP</strong><br/>By: ______________________<br/>[Attorney Name]</p>`,
    },
  },
  {
    id: "settlement-demand",
    kind: "docx",
    name: "Settlement demand letter",
    category: "Correspondence",
    source: "firm",
    description: "Demand letter: liability summary, damages itemization, demand and deadline.",
    payload: {
      format: "html",
      html: `<p>[Date]</p><p><strong>FOR SETTLEMENT PURPOSES ONLY – FRE 408</strong></p>
<p>[Adjuster / Counsel]<br/>[Company]<br/>[Address]</p>
<p><strong>Re: [Claimant] v. [Insured]; Claim No. [x]; Date of Loss [date]</strong></p>
<p>Dear [Name]:</p>
<h2>Liability</h2><p>[Facts establishing liability.]</p>
<h2>Injuries and Treatment</h2><p>[Summary of injuries, treatment, prognosis.]</p>
<h2>Damages</h2><table><thead><tr><th>Category</th><th>Amount</th></tr></thead><tbody><tr><td>Past medical expenses</td><td>$[x]</td></tr><tr><td>Future medical expenses</td><td>$[x]</td></tr><tr><td>Lost wages</td><td>$[x]</td></tr><tr><td>Pain and suffering</td><td>$[x]</td></tr><tr><td><strong>Total</strong></td><td><strong>$[x]</strong></td></tr></tbody></table>
<h2>Demand</h2><p>[Claimant] demands $[amount] in full settlement. This demand remains open until [date].</p>
<p>Very truly yours,<br/><br/>[Attorney Name]<br/>Seeger Weiss LLP</p>`,
    },
  },
  {
    id: "case-status-report",
    kind: "docx",
    name: "Case status report",
    category: "Case management",
    source: "firm",
    description: "Periodic status report to client or co-counsel: posture, recent events, upcoming deadlines, budget, risks.",
    payload: {
      format: "html",
      html: `<h1>[Matter] – Status Report</h1><p><em>As of [Date]. Privileged and confidential.</em></p>
<h2>Procedural Posture</h2><p>[Court, judge, stage of the case.]</p>
<h2>Developments Since Last Report</h2><ul><li>[Event and date]</li></ul>
<h2>Upcoming Deadlines</h2><table><thead><tr><th>Date</th><th>Event</th><th>Responsible</th></tr></thead><tbody><tr><td>[Date]</td><td>[Deadline]</td><td>[Name]</td></tr></tbody></table>
<h2>Strategy and Risks</h2><p>[Assessment.]</p>
<h2>Budget</h2><p>[Fees and costs to date vs. budget.]</p>
<h2>Action Items</h2><ul><li>[Item – owner – date]</li></ul>`,
    },
  },
  {
    id: "meeting-minutes",
    kind: "docx",
    name: "Meeting minutes",
    category: "Internal",
    source: "firm",
    description: "Attendees, agenda, decisions, action items.",
    payload: {
      format: "html",
      html: `<h1>Meeting Minutes – [Topic]</h1>
<table><tbody><tr><td><strong>Date</strong></td><td>[Date, time]</td></tr><tr><td><strong>Attendees</strong></td><td>[Names]</td></tr><tr><td><strong>Prepared by</strong></td><td>[Name]</td></tr></tbody></table>
<h2>Agenda</h2><ol><li>[Item]</li></ol>
<h2>Discussion and Decisions</h2><h3>[Item 1]</h3><p>[Summary and decision.]</p>
<h2>Action Items</h2><table><thead><tr><th>Action</th><th>Owner</th><th>Due</th></tr></thead><tbody><tr><td>[Action]</td><td>[Name]</td><td>[Date]</td></tr></tbody></table>`,
    },
  },
  {
    id: "expert-report-outline",
    kind: "docx",
    name: "Expert report outline",
    category: "Experts",
    source: "firm",
    description: "Rule 26(a)(2)(B) report skeleton: qualifications, materials, opinions, bases, compensation, prior testimony.",
    payload: {
      format: "html",
      html: `<h1 style="text-align:center">EXPERT REPORT OF [NAME], [CREDENTIALS]</h1>
<p style="text-align:center">[Case caption short form] | [Date]</p>
<h2>I. Introduction and Assignment</h2><p>[Who retained the expert and the questions asked.]</p>
<h2>II. Qualifications</h2><p>[Summary; CV attached as Exhibit A.]</p>
<h2>III. Materials Considered</h2><p>[List; Exhibit B.]</p>
<h2>IV. Summary of Opinions</h2><ol><li>[Opinion 1]</li><li>[Opinion 2]</li></ol>
<h2>V. Bases and Reasons</h2><h3>A. [Opinion 1]</h3><p>[Methodology, data, analysis.]</p>
<h2>VI. Compensation</h2><p>[Rate.]</p>
<h2>VII. Prior Testimony (past four years)</h2><p>[List.]</p>
<h2>VIII. Reservation of Rights</h2><p>[Right to supplement.]</p>
<p>______________________<br/>[Name]<br/>[Date]</p>`,
    },
  },
  {
    id: "engagement-letter",
    kind: "docx",
    name: "Engagement letter",
    category: "Correspondence",
    source: "firm",
    description: "Scope of representation, fees, costs, client responsibilities, termination, signature.",
    payload: {
      format: "html",
      html: `<p>[Date]</p><p>[Client Name]<br/>[Address]</p><p><strong>Re: Engagement of Seeger Weiss LLP – [Matter]</strong></p><p>Dear [Name]:</p>
<p>Thank you for selecting Seeger Weiss LLP. This letter confirms the terms of our engagement.</p>
<h2>1. Scope of Representation</h2><p>[Scope; matters excluded.]</p>
<h2>2. Fees and Costs</h2><p>[Contingency percentage / hourly rates; treatment of costs.]</p>
<h2>3. Client Responsibilities</h2><p>[Cooperation, preservation of documents, communication.]</p>
<h2>4. Termination</h2><p>[Either party may terminate; lien and fee treatment.]</p>
<h2>5. Conflicts and Confidentiality</h2><p>[Statement.]</p>
<p>If these terms are acceptable, please sign below and return a copy.</p>
<p>Sincerely,<br/><br/>[Attorney Name]<br/>Seeger Weiss LLP</p>
<p>AGREED AND ACCEPTED:<br/><br/>______________________<br/>[Client Name]  Date: ________</p>`,
    },
  },
  {
    id: "table-of-authorities-skeleton",
    kind: "docx",
    name: "Table of authorities skeleton",
    category: "Court filings",
    source: "firm",
    description: "TOA sections (Cases, Statutes, Rules, Other) as tables ready to fill from the brief.",
    payload: {
      format: "html",
      html: `<h1 style="text-align:center">TABLE OF AUTHORITIES</h1>
<h2>Cases</h2><table><thead><tr><th>Authority</th><th>Page(s)</th></tr></thead><tbody><tr><td><em>[Party v. Party]</em>, [cite]</td><td>[x]</td></tr></tbody></table>
<h2>Statutes</h2><table><thead><tr><th>Authority</th><th>Page(s)</th></tr></thead><tbody><tr><td>[28 U.S.C. § ____]</td><td>[x]</td></tr></tbody></table>
<h2>Rules</h2><table><thead><tr><th>Authority</th><th>Page(s)</th></tr></thead><tbody><tr><td>[Fed. R. Civ. P. __]</td><td>[x]</td></tr></tbody></table>
<h2>Other Authorities</h2><table><thead><tr><th>Authority</th><th>Page(s)</th></tr></thead><tbody><tr><td>[Treatise / article]</td><td>[x]</td></tr></tbody></table>`,
    },
  },
  {
    id: "pleading-caption",
    kind: "docx",
    name: "Pleading caption",
    category: "Court filings",
    source: "firm",
    description: "Court caption block: court, parties, case number, judge and document title, ready to fill.",
    payload: {
      format: "html",
      html: `<p style="text-align:center"><strong>[COURT]<br/>[DISTRICT / DIVISION]</strong></p>
<table><tbody>
<tr><td>[PLAINTIFF],<br/><br/>Plaintiff,<br/><br/>v.<br/><br/>[DEFENDANT],<br/><br/>Defendant.</td><td>Case No. [x:xx-cv-xxxxx]<br/><br/>[Hon. Judge Name]<br/><br/>[DOCUMENT TITLE]</td></tr>
</tbody></table>`,
    },
  },

  // ---------------------------------------------------------------- Sheets (xlsx)
  {
    id: "damages-calculation",
    kind: "xlsx",
    name: "Damages calculation",
    category: "Damages",
    source: "firm",
    description: "Itemized economic and non-economic damages with subtotals, interest and total.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Category", "Item", "Amount", "Source / Basis", "Notes"], [180, 260, 130, 260, 260], "[Matter] – Damages Calculation"),
        {
          op: "set_range",
          sheetId: S,
          start: "A4",
          values: [
            ["Economic", "Past medical expenses", 0, "[Medical bills summary]", ""],
            ["Economic", "Future medical expenses", 0, "[Life care plan]", ""],
            ["Economic", "Past lost wages", 0, "[Employer records]", ""],
            ["Economic", "Future lost earning capacity", 0, "[Economist report]", ""],
            ["Economic", "Property damage / other", 0, "", ""],
            ["", "Economic subtotal", "=SUM(C4:C8)", "", ""],
            ["Non-economic", "Pain and suffering", 0, "", ""],
            ["Non-economic", "Loss of enjoyment of life", 0, "", ""],
            ["Non-economic", "Loss of consortium", 0, "", ""],
            ["", "Non-economic subtotal", "=SUM(C10:C12)", "", ""],
            ["", "Prejudgment interest rate", 0.0, "[Statutory rate]", "Enter as decimal"],
            ["", "Years of interest", 0, "", ""],
            ["", "Prejudgment interest", "=C9*C14*C15", "", ""],
            ["", "TOTAL DAMAGES", "=C9+C13+C16", "", ""],
          ],
        },
        { op: "format_range", sheetId: S, range: "C4:C17", format: { numberFormat: "$#,##0.00" } },
        { op: "format_range", sheetId: S, range: "C14:C14", format: { numberFormat: "0.00%" } },
        { op: "format_range", sheetId: S, range: "C15:C15", format: { numberFormat: "0" } },
        { op: "format_range", sheetId: S, range: "A9:E9", format: { bold: true, fillColor: BAND_FILL } },
        { op: "format_range", sheetId: S, range: "A13:E13", format: { bold: true, fillColor: BAND_FILL } },
        { op: "format_range", sheetId: S, range: "A17:E17", format: { bold: true, fillColor: HEADER_FILL, fontColor: "#FFFFFF" } },
      ],
    },
  },
  {
    id: "client-billing",
    kind: "xlsx",
    name: "Client billing",
    category: "Finance",
    source: "firm",
    description: "Time entries with timekeeper, rate, hours, a computed amount per line and a running total.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Date", "Timekeeper", "Task code", "Narrative", "Hours", "Rate", "Amount"], [110, 150, 100, 360, 80, 90, 120], "[Matter] – Billing"),
        {
          op: "set_range",
          sheetId: S,
          start: "A4",
          values: [
            ["", "", "", "", 0, 0, "=E4*F4"],
            ["", "", "", "", 0, 0, "=E5*F5"],
            ["", "", "", "", 0, 0, "=E6*F6"],
            ["", "", "", "Total", "=SUM(E4:E6)", "", "=SUM(G4:G6)"],
          ],
        },
        { op: "format_range", sheetId: S, range: "E4:E7", format: { numberFormat: "0.00" } },
        { op: "format_range", sheetId: S, range: "F4:G7", format: { numberFormat: "$#,##0.00" } },
        { op: "format_range", sheetId: S, range: "A7:G7", format: { bold: true, fillColor: BAND_FILL } },
      ],
    },
  },
  {
    id: "case-chronology",
    kind: "xlsx",
    name: "Case chronology",
    category: "Case management",
    source: "firm",
    description: "Dated event log with source, witnesses, significance and issue tags.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Date", "Event", "Source / Bates", "Witnesses", "Significance", "Issue tag"], [110, 360, 180, 160, 300, 120], "[Matter] – Chronology"),
        { op: "format_range", sheetId: S, range: "A4:A200", format: { numberFormat: "yyyy-mm-dd" } },
      ],
    },
  },
  {
    id: "discovery-tracker",
    kind: "xlsx",
    name: "Discovery tracker",
    category: "Discovery",
    source: "firm",
    description: "Requests served/received with due dates, status and follow-up.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(
          ["Set", "Request #", "Type", "Served by", "Served on", "Date served", "Response due", "Status", "Deficiencies", "Follow-up"],
          [120, 90, 130, 120, 120, 110, 110, 110, 260, 220],
          "[Matter] – Discovery Tracker",
        ),
        { op: "format_range", sheetId: S, range: "F4:G200", format: { numberFormat: "yyyy-mm-dd" } },
        {
          op: "set_data_validation",
          sheetId: S,
          range: "H4:H200",
          validation: { kind: "list", values: ["Outstanding", "Received", "Deficient", "Meet and confer", "Motion", "Closed"] },
        },
      ],
    },
  },
  {
    id: "deposition-schedule",
    kind: "xlsx",
    name: "Deposition schedule",
    category: "Discovery",
    source: "firm",
    description: "Witness list with dates, location, examiners and prep status.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(
          ["Witness", "Role", "Noticed by", "Date", "Time", "Location / Remote", "Examining attorney", "Defending attorney", "Prep status", "Notes"],
          [180, 140, 120, 110, 80, 180, 160, 160, 120, 240],
          "[Matter] – Deposition Schedule",
        ),
        { op: "format_range", sheetId: S, range: "D4:D200", format: { numberFormat: "yyyy-mm-dd" } },
      ],
    },
  },
  {
    id: "privilege-log",
    kind: "xlsx",
    name: "Privilege log",
    category: "Discovery",
    source: "firm",
    description: "Rule 26(b)(5) log: Bates, date, author, recipients, description, privilege asserted.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(
          ["Log #", "Bates begin", "Bates end", "Date", "Doc type", "Author", "Recipients", "CC", "Description", "Privilege asserted", "Basis"],
          [70, 120, 120, 100, 110, 160, 200, 160, 320, 150, 220],
          "[Matter] – Privilege Log",
        ),
        { op: "format_range", sheetId: S, range: "D4:D500", format: { numberFormat: "yyyy-mm-dd" } },
        {
          op: "set_data_validation",
          sheetId: S,
          range: "J4:J500",
          validation: { kind: "list", values: ["Attorney-client", "Work product", "Both", "Common interest", "Other"] },
        },
      ],
    },
  },
  {
    id: "litigation-budget",
    kind: "xlsx",
    name: "Litigation budget",
    category: "Finance",
    source: "firm",
    description: "Phase budget with estimated and actual fees and costs, variance.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Phase", "Task", "Est. hours", "Rate", "Est. fees", "Est. costs", "Actual fees", "Actual costs", "Variance"], [160, 260, 90, 90, 120, 110, 120, 110, 110], "[Matter] – Litigation Budget"),
        {
          op: "set_range",
          sheetId: S,
          start: "A4",
          values: [
            ["Pleadings", "Complaint and initial motions", 0, 0, "=C4*D4", 0, 0, 0, "=(E4+F4)-(G4+H4)"],
            ["Discovery", "Written discovery", 0, 0, "=C5*D5", 0, 0, 0, "=(E5+F5)-(G5+H5)"],
            ["Discovery", "Depositions", 0, 0, "=C6*D6", 0, 0, 0, "=(E6+F6)-(G6+H6)"],
            ["Experts", "Retention and reports", 0, 0, "=C7*D7", 0, 0, 0, "=(E7+F7)-(G7+H7)"],
            ["Motions", "Dispositive motions", 0, 0, "=C8*D8", 0, 0, 0, "=(E8+F8)-(G8+H8)"],
            ["Trial", "Preparation and trial", 0, 0, "=C9*D9", 0, 0, 0, "=(E9+F9)-(G9+H9)"],
            ["", "TOTAL", "=SUM(C4:C9)", "", "=SUM(E4:E9)", "=SUM(F4:F9)", "=SUM(G4:G9)", "=SUM(H4:H9)", "=SUM(I4:I9)"],
          ],
        },
        { op: "format_range", sheetId: S, range: "D4:I10", format: { numberFormat: "$#,##0" } },
        { op: "format_range", sheetId: S, range: "A10:I10", format: { bold: true, fillColor: BAND_FILL } },
      ],
    },
  },
  {
    id: "sol-tracker",
    kind: "xlsx",
    name: "Statute of limitations tracker",
    category: "Case management",
    source: "firm",
    description: "Per-claimant accrual dates, applicable period, tolling and deadline with days-remaining formula.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Claimant", "Jurisdiction", "Claim", "Accrual date", "Period (years)", "Tolling (days)", "Deadline", "Days remaining", "Status", "Notes"], [180, 120, 160, 110, 90, 90, 110, 100, 110, 240], "[Matter] – Limitations Tracker"),
        { op: "set_range", sheetId: S, start: "A4", values: [["[Name]", "[State]", "[Claim]", "", 2, 0, "=IF(D4=\"\",\"\",EDATE(D4,E4*12)+F4)", "=IF(G4=\"\",\"\",G4-TODAY())", "", ""]] },
        { op: "format_range", sheetId: S, range: "D4:D500", format: { numberFormat: "yyyy-mm-dd" } },
        { op: "format_range", sheetId: S, range: "G4:G500", format: { numberFormat: "yyyy-mm-dd" } },
        { op: "add_conditional_format", sheetId: S, range: "H4:H500", rule: { kind: "number", operator: "lessThan", value: 90, format: { fillColor: "#FDE2E2", fontColor: "#8A1C1C" } } },
      ],
    },
  },
  {
    id: "witness-list",
    kind: "xlsx",
    name: "Witness list",
    category: "Trial",
    source: "firm",
    description: "Trial witnesses with topics, exhibits, estimated time and availability.",
    payload: {
      format: "ops",
      operations: [
        ...sheetFrame(["Witness", "Side", "Type", "Topics", "Key exhibits", "Est. direct (min)", "Est. cross (min)", "Availability", "Subpoena", "Notes"], [180, 80, 100, 300, 180, 100, 100, 140, 90, 240], "[Matter] – Witness List"),
      ],
    },
  },

  // ---------------------------------------------------------------- Slides (pptx)
  {
    id: "mdl-status-deck",
    kind: "pptx",
    name: "MDL status deck",
    category: "Case management",
    source: "firm",
    description: "Leadership status update: docket posture, bellwethers, discovery, science, settlement, next 90 days.",
    payload: {
      format: "deck",
      deck: {
        title: "[MDL Name] – Status Update",
        styleId: "firm",
        mode: "append",
        slides: [
          { layout: "cover", title: "[MDL Name] – Status Update", subtitle: "[Committee] | [Month Year]", footer: "Privileged and confidential" },
          { layout: "content", title: "Docket posture", items: [{ heading: "Court", text: "[Judge, district, JPML transfer date]" }, { heading: "Cases", text: "[Filed / pending / dismissed counts]" }, { heading: "Key orders", text: "[CMO numbers and subjects]" }] },
          { layout: "timeline", title: "Bellwether schedule", items: [{ heading: "[Date]", text: "[Trial pool selection]" }, { heading: "[Date]", text: "[Expert discovery closes]" }, { heading: "[Date]", text: "[First trial]" }] },
          { layout: "two-column", title: "Discovery", items: [{ heading: "Defendants", text: "[Productions, custodians, deficiencies]" }, { heading: "Plaintiffs", text: "[PFS compliance, records collection]" }] },
          { layout: "content", title: "Science and experts", items: [{ heading: "General causation", text: "[Status]" }, { heading: "Daubert", text: "[Briefing schedule]" }] },
          { layout: "content", title: "Settlement", items: [{ heading: "Posture", text: "[Mediation, negotiations]" }] },
          { layout: "process", title: "Next 90 days", items: [{ heading: "[Task]", text: "[Owner, date]" }, { heading: "[Task]", text: "[Owner, date]" }, { heading: "[Task]", text: "[Owner, date]" }] },
          { layout: "closing", title: "Questions", subtitle: "[Contact]" },
        ],
      },
    },
  },
  {
    id: "case-overview-deck",
    kind: "pptx",
    name: "Case overview",
    category: "Case management",
    source: "firm",
    description: "Intake or team briefing: parties, facts, claims, defenses, damages, plan.",
    payload: {
      format: "deck",
      deck: {
        title: "[Matter] – Case Overview",
        styleId: "firm",
        mode: "append",
        slides: [
          { layout: "cover", title: "[Matter] – Case Overview", subtitle: "[Date]", footer: "Privileged and confidential" },
          { layout: "two-column", title: "Parties", items: [{ heading: "Plaintiff(s)", text: "[Names, background]" }, { heading: "Defendant(s)", text: "[Names, background]" }] },
          { layout: "timeline", title: "Key facts", items: [{ heading: "[Date]", text: "[Event]" }, { heading: "[Date]", text: "[Event]" }, { heading: "[Date]", text: "[Event]" }] },
          { layout: "content", title: "Claims", items: [{ heading: "[Claim 1]", text: "[Elements and support]" }, { heading: "[Claim 2]", text: "[Elements and support]" }] },
          { layout: "content", title: "Anticipated defenses", items: [{ heading: "[Defense]", text: "[Response]" }] },
          { layout: "content", title: "Damages", items: [{ heading: "Economic", text: "[Summary]" }, { heading: "Non-economic", text: "[Summary]" }] },
          { layout: "process", title: "Plan", items: [{ heading: "Investigate", text: "[Steps]" }, { heading: "Plead", text: "[Steps]" }, { heading: "Discover", text: "[Steps]" }] },
        ],
      },
    },
  },
  {
    id: "mediation-deck",
    kind: "pptx",
    name: "Mediation presentation",
    category: "Settlement",
    source: "firm",
    description: "Liability story, damages, verdict risk, demand.",
    payload: {
      format: "deck",
      deck: {
        title: "[Matter] – Mediation Statement",
        styleId: "navy",
        mode: "append",
        slides: [
          { layout: "cover", title: "[Matter]", subtitle: "Mediation presentation | [Date]", footer: "For settlement purposes only – FRE 408" },
          { layout: "content", title: "Why liability is clear", items: [{ heading: "[Point]", text: "[Evidence]" }, { heading: "[Point]", text: "[Evidence]" }] },
          { layout: "timeline", title: "What happened", items: [{ heading: "[Date]", text: "[Event]" }, { heading: "[Date]", text: "[Event]" }] },
          { layout: "content", title: "Injuries and impact", items: [{ heading: "Medical", text: "[Summary]" }, { heading: "Life impact", text: "[Summary]" }] },
          { layout: "comparison", title: "Verdict range", items: [{ heading: "Comparable verdicts", text: "[Cases and amounts]" }, { heading: "Defense exposure", text: "[Fees, interest, risk]" }] },
          { layout: "closing", title: "Demand: $[amount]", subtitle: "[Terms and deadline]" },
        ],
      },
    },
  },
  {
    id: "client-update-deck",
    kind: "pptx",
    name: "Client update",
    category: "Correspondence",
    source: "firm",
    description: "Short client-facing update: where we are, what happened, what is next.",
    payload: {
      format: "deck",
      deck: {
        title: "[Matter] – Client Update",
        styleId: "plain",
        mode: "append",
        slides: [
          { layout: "cover", title: "[Matter] – Update", subtitle: "[Date]" },
          { layout: "content", title: "Where we are", items: [{ heading: "Stage", text: "[Posture]" }] },
          { layout: "content", title: "Recent developments", items: [{ heading: "[Event]", text: "[What it means]" }] },
          { layout: "process", title: "What happens next", items: [{ heading: "[Step]", text: "[Timing]" }, { heading: "[Step]", text: "[Timing]" }] },
          { layout: "closing", title: "Questions", subtitle: "[Contact]" },
        ],
      },
    },
  },
  {
    id: "expert-summary-deck",
    kind: "pptx",
    name: "Expert opinion summary",
    category: "Experts",
    source: "firm",
    description: "One expert's qualifications, methodology, opinions and cross-examination themes.",
    payload: {
      format: "deck",
      deck: {
        title: "[Expert] – Opinion Summary",
        styleId: "slate",
        mode: "append",
        slides: [
          { layout: "cover", title: "[Expert Name], [Credentials]", subtitle: "[Field] | Retained by [party]" },
          { layout: "content", title: "Qualifications", items: [{ heading: "Training", text: "[Degrees, boards]" }, { heading: "Experience", text: "[Practice, publications]" }] },
          { layout: "content", title: "Methodology", items: [{ heading: "Approach", text: "[Method and data]" }] },
          { layout: "content", title: "Opinions", items: [{ heading: "Opinion 1", text: "[Statement]" }, { heading: "Opinion 2", text: "[Statement]" }] },
          { layout: "two-column", title: "Cross-examination themes", items: [{ heading: "Strengths", text: "[Points]" }, { heading: "Vulnerabilities", text: "[Points]" }] },
        ],
      },
    },
  },
  {
    id: "trial-themes-deck",
    kind: "pptx",
    name: "Trial themes",
    category: "Trial",
    source: "firm",
    description: "Opening-statement storyboard: theme, cast, timeline, proof, ask.",
    payload: {
      format: "deck",
      deck: {
        title: "[Matter] – Trial Themes",
        styleId: "ink",
        mode: "append",
        slides: [
          { layout: "cover", title: "[Theme statement]", subtitle: "[Matter]" },
          { layout: "three-column", title: "The cast", items: [{ heading: "[Plaintiff]", text: "[One line]" }, { heading: "[Defendant]", text: "[One line]" }, { heading: "[Key witness]", text: "[One line]" }] },
          { layout: "timeline", title: "The story", items: [{ heading: "[Date]", text: "[Event]" }, { heading: "[Date]", text: "[Event]" }, { heading: "[Date]", text: "[Event]" }] },
          { layout: "content", title: "What the evidence will show", items: [{ heading: "[Proof point]", text: "[Exhibit / witness]" }, { heading: "[Proof point]", text: "[Exhibit / witness]" }] },
          { layout: "closing", title: "The ask", subtitle: "[Verdict requested]" },
        ],
      },
    },
  },
];

// --- Store ------------------------------------------------------------------------------------

function summaryOf(t: TemplateDetail): TemplateSummary {
  const { payload: _payload, ...rest } = t;
  return rest;
}

export async function listTemplates(principal: string, kindRaw: string): Promise<TemplateSummary[]> {
  const kind = kindOf(kindRaw);
  const firm = FIRM_TEMPLATES.filter((t) => t.kind === kind).map(summaryOf);
  const rows = await queryPrefix(userPK(principal), `TPL#${kind}#`).catch(() => []);
  const mine: TemplateSummary[] = rows.map((r) => ({
    id: String(r["templateId"] ?? ""),
    kind,
    name: String(r["name"] ?? "Untitled"),
    description: String(r["description"] ?? ""),
    category: String(r["category"] ?? "My templates"),
    source: "mine",
    createdAt: String(r["createdAt"] ?? ""),
  }));
  mine.sort((a, b) => (a.createdAt! < b.createdAt! ? 1 : -1));
  return [...mine, ...firm];
}

export async function getTemplate(principal: string, kindRaw: string, id: string): Promise<TemplateDetail> {
  const kind = kindOf(kindRaw);
  const firm = FIRM_TEMPLATES.find((t) => t.kind === kind && t.id === id);
  if (firm) return firm;
  const row = await getItem(userPK(principal), tplSK(kind, id));
  if (!row) throw new OfficeError(404, `Template "${id}" not found for ${kind}.`);
  let payload: JsonValue = null;
  try {
    payload = JSON.parse(String(row["payload"] ?? "null")) as JsonValue;
  } catch {
    throw new OfficeError(500, "The saved template could not be read.");
  }
  return {
    id,
    kind,
    name: String(row["name"] ?? "Untitled"),
    description: String(row["description"] ?? ""),
    category: String(row["category"] ?? "My templates"),
    source: "mine",
    createdAt: String(row["createdAt"] ?? ""),
    payload,
  };
}

export async function saveTemplate(
  principal: string,
  input: { kind: string; name: string; description?: string; category?: string; payload: unknown },
): Promise<TemplateSummary> {
  const kind = kindOf(input.kind);
  const name = String(input.name ?? "").trim().slice(0, 120);
  if (!name) throw new OfficeError(422, "name is required.");
  const payload = JSON.stringify(input.payload ?? null);
  if (payload === "null") throw new OfficeError(422, "payload is required.");
  if (payload.length > MAX_PAYLOAD_CHARS) throw new OfficeError(413, "The template is too large to save.");
  const format = (input.payload as { format?: string } | null)?.format;
  const expected = kind === "docx" ? "html" : kind === "xlsx" ? "ops" : "deck";
  if (format !== expected) throw new OfficeError(422, `A ${kind} template payload must have format "${expected}".`);
  const existing = await queryPrefix(userPK(principal), `TPL#${kind}#`).catch(() => []);
  if (existing.length >= MAX_USER_TEMPLATES) throw new OfficeError(413, "Template limit reached; delete one first.");
  const id = ulid().toLowerCase();
  const now = new Date().toISOString();
  await putItem({
    PK: userPK(principal),
    SK: tplSK(kind, id),
    entity: "template",
    type: "template",
    kind,
    templateId: id,
    owner: principal,
    name,
    description: String(input.description ?? "").slice(0, 400),
    category: String(input.category ?? "My templates").slice(0, 60),
    payload,
    createdAt: now,
    updatedAt: now,
  });
  return { id, kind, name, description: String(input.description ?? ""), category: String(input.category ?? "My templates"), source: "mine", createdAt: now };
}

export async function deleteTemplate(principal: string, kindRaw: string, id: string): Promise<void> {
  const kind = kindOf(kindRaw);
  if (FIRM_TEMPLATES.some((t) => t.kind === kind && t.id === id)) throw new OfficeError(403, "Firm templates cannot be deleted.");
  await deleteItem(userPK(principal), tplSK(kind, id));
}
