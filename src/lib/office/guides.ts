// ============================================================================
// Firm playbooks the Office assistants load on demand (load_firm_guide).
// These are working conventions for Seeger Weiss deliverables, written for a
// model that is about to edit a document: what to include, in what order, how
// to format. They are guidance, not authority; the attorney reviews the work.
// Keep each guide short enough to read in one tool result.
// ============================================================================

export type FirmGuide = {
  id: string;
  title: string;
  /** Which editors this guide is useful in. */
  apps: Array<"writer" | "sheets" | "slides">;
  summary: string;
  body: string;
};

const GUIDES: FirmGuide[] = [
  {
    id: "native-office-workflow",
    title: "Reliable native Office creation, editing and delivery",
    apps: ["writer", "sheets", "slides"],
    summary: "Read → plan → bounded edits → verify → save/export, with source fidelity, dependency ordering and failure recovery.",
    body: `# Reliable native Office workflow

Use only the current tool definitions. Desktop CLI commands, local paths and cloud-generation features from an external guide do not become available in this browser. The user's exact text, dimensions, formats and scope override design defaults.

## Prepare and execute
- Read the document outline/workbook context/current slides once. Identify target IDs, source facts, output format and a short completion checklist. Load only relevant operation guides. Ask only when ambiguity would materially change the result.
- For real figures, read the primary source and retain units, period, source URL/page and as-of date. Label requested mock data as illustrative in the artifact. Missing data is not zero. Reuse verified reads until the source or document changes.
- Group independent reads in one turn. Batch compatible edits within the tool's limit; await writes before dependent reads, calculations or further writes. Do not send simultaneous writes to the same document. Structural edits invalidate addresses/IDs: re-read before the next batch.
- Keep progress in small completed stages: source/structure, content/formulas, formatting, verification. Do not paste the entire deliverable into chat or repeatedly fetch the same guide. Stop cosmetic iterations once the requested quality checks pass.

## Writer
- Use read_document_outline/search_document to locate sections and read_blocks for affected text. Apply formatting with apply_commands; preserve content, citations, comments and unrelated structure. Use insert_content/replace_blocks only for requested content changes, native table/chart tools for editable objects, and set_page_setup for actual page settings.
- Run audit_document for introduced structural defects; read affected blocks and inspect representative pages with view_page when supplied. A visual check cannot verify quotations or sources. Do not resolve tracked changes or simulate unsupported floating objects by flattening the document.

## Sheets
- Separate assumptions/input data from formula-driven calculations. Create sheets/structural changes in their own batch, obtain current sheet IDs, then write formulas and formats. Load financial-formatting and charts only when relevant.
- Read computed values and representative formats after edits. Check errors with find_cells/trace_precedents; reconcile totals, percentages, units and periods. Charts should link to ranges and use appropriate axis number formats; zero and missing values must remain distinct. Use native charts, not pictures of charts.
- Use create_document only according to its supplied schema. Worksheet XLSX/CSV export is a values-only derivative; it does not preserve the full workbook's formulas, styles, charts or other sheets. The editor's Save then Download preserves the native workbook. Do not describe a values-only derivative as the complete workbook.

## Slides
- For a new deck, choose an available template or native create_presentation/design_slide_html workflow, a coherent outline and consistent design tokens. For an existing deck, read_slide and load_guide, then use scoped apply_ops/edit tools with existing IDs; do not regenerate the deck for a small edit.
- Keep text, tables and charts native/editable. audit_layout reports geometry findings; view_slide, when available, checks rendering. Repair only introduced issues within the user's scope, at most two focused polish passes. Preserve an intentional overlap or exact requested size rather than rewriting to satisfy an advisory audit.

## Recover and deliver
- A failed/partial tool may have changed state. Read its receipt, inspect the current artifact and repair only remaining work; never replay an entire batch blindly. If the run rolled back, historical tool receipts do not prove those edits remain. A checkpoint requires an explicit continuation.
- Verify the actual requested result, then distinguish edited, saved and downloaded. Claim a save/export only after its success receipt or editor revision confirms it. Name any unsupported feature, incomplete calculation or unavailable visual check. Native-format support is not a guarantee of every Microsoft Office feature or pixel-identical rendering.`,
  },
  {
    id: "bluebook-citations",
    title: "Citation form (Bluebook conventions)",
    apps: ["writer", "slides"],
    summary: "Case, statute, regulation, record and short-form citation patterns used in firm filings.",
    body: `# Citation form (Bluebook conventions)

Use these patterns for anything the firm files or sends. When a cite comes from research, run verify_citations before relying on it; never invent a reporter cite.

## Cases
- Full cite: *Party v. Party*, Volume Reporter First-page, Pin-page (Court Year).
  Example: *Daubert v. Merrell Dow Pharms., Inc.*, 509 U.S. 579, 589 (1993).
- Court and year: omit the court for U.S. Supreme Court (U.S.); give the circuit for federal appeals (2d Cir. 2019); district for trial courts (D.N.J. 2021, S.D.N.Y. 2020).
- Case names: italicize (or underline in a document that uses underlining throughout); abbreviate per Bluebook T6 in citation sentences (Pharms., Inc., Corp., Co.); "v." always lowercase.
- Short form after a full cite: *Daubert*, 509 U.S. at 592. Use *Id.* (italicized, with the period) for the immediately preceding authority; *Id.* at 594 for a different page.
- Subsequent history: aff'd, rev'd, cert. denied, with the later cite: ..., aff'd, 43 F.4th 1 (3d Cir. 2022).
- Unpublished: give the docket number, database cite and full date: *Smith v. Jones*, No. 2:20-cv-01234, 2021 WL 123456, at *3 (D.N.J. Mar. 4, 2021).
- Parentheticals: explanatory parentheticals begin with a present participle and no period inside unless a full sentence is quoted: (holding that ...).

## Statutes and regulations
- Federal statute: 28 U.S.C. § 1332(d) (year optional in current practice). Use the section symbol with a space: § 1332, §§ 1331-1332.
- Regulation: 21 C.F.R. § 314.70 (2024). Federal Register: 88 Fed. Reg. 12345 (Feb. 28, 2023).
- State statute: follow the state's Bluebook T1 form: N.J. Stat. Ann. § 2A:58C-2 (West 2023); Cal. Civ. Code § 1714 (West 2024).

## Rules and record
- Rules: Fed. R. Civ. P. 26(b)(1); Fed. R. Evid. 702.
- Record cites in briefs: (ECF No. 45 at 12); deposition: (Smith Dep. 45:12-46:3); exhibits: (Ex. B at 4).
- Consistent style inside one document beats mixing forms; when the document already uses a convention, match it.

## Signals
- No signal for direct support; *See* for clear support by inference; *See also* for additional support; *Cf.* for analogous support; *But see* for contrary authority. Italicize signals; separate multiple authorities with semicolons.

## Checks before finishing
- Every cited case has a reporter cite and a pin page where a proposition is attributed.
- Party names, years and courts match the verified source.
- Short forms only after a full cite earlier in the same document.`,
  },
  {
    id: "table-of-authorities",
    title: "Table of Authorities",
    apps: ["writer"],
    summary: "How to build and format a TOA for a brief.",
    body: `# Table of Authorities

Build the TOA after the brief text is final; it lists every authority cited and the pages where each appears.

## Structure (in this order)
1. Cases (alphabetical by first party; federal and state together unless the court's rules split them)
2. Constitutional Provisions
3. Statutes
4. Rules
5. Regulations
6. Other Authorities (treatises, law review articles, legislative history, websites)

## Formatting
- Heading "TABLE OF AUTHORITIES" centered, bold, same font as the brief.
- Section headings bold, left-aligned, small caps or plain caps to match the Table of Contents.
- Each entry: the full citation (no pin page) followed by a right-aligned dotted leader and the page numbers where it is cited (e.g. "3, 7, 12"). Use "passim" only when an authority appears on six or more pages and the local rules allow it.
- Hanging indent for entries that wrap (0.5 inch).
- Case names italicized exactly as in the text; do not abbreviate differently from the body.
- Single space within an entry, one blank line between entries or 6 pt space after.

## Page references
- Cite page numbers of the brief, not the record. Re-check after any edit that changes pagination.
- Do not list authorities that appear only in the TOA itself or only in the caption.

## Working method in the Writer
- First collect every citation from the body with read_blocks; de-duplicate short forms back to their full cite.
- Then insert the TOA after the Table of Contents as headings plus a two-column table (authority | pages) or tab-leader paragraphs, whichever the document already uses.`,
  },
  {
    id: "deposition-summary",
    title: "Deposition summary memo",
    apps: ["writer"],
    summary: "Structure and conventions for a page-line deposition summary.",
    body: `# Deposition summary memo

Purpose: let an attorney who did not attend understand what the witness said, where to find it, and why it matters, in a fraction of the transcript's length.

## Header
- Privileged and Confidential / Attorney Work Product line at the top.
- Matter caption or short name, witness name and role, deposition date, taking and defending counsel, transcript length, exhibits marked.

## Body
1. Overview (one paragraph): who the witness is and the two or three most important admissions or denials.
2. Key testimony by topic. Each topic heading is a plain statement (e.g. "Knowledge of the 2019 label change"). Under each: short summaries with page:line cites in parentheses, e.g. (45:12-47:3). Quote verbatim only where the exact words matter (admissions, impeachment).
3. Exhibits discussed: exhibit number, description, what the witness said about it, page:line.
4. Credibility and demeanor notes, if instructed to include them.
5. Follow-up: open questions, documents to request, witnesses identified.

## Conventions
- Page:line cites for every factual statement; ranges with an en dash or hyphen, consistently.
- Present tense for what the transcript shows ("Smith testifies"), past tense for events described.
- Neutral wording; characterizations (evasive, contradicted) go in the credibility section, not the summary.
- Length: aim for one page of summary per 25-40 transcript pages unless told otherwise.
- Redact or omit PHI that is not needed for the legal point; refer to plaintiffs by name only as the matter's protective order allows.`,
  },
  {
    id: "damages-table",
    title: "Damages and settlement tables",
    apps: ["sheets", "writer"],
    summary: "Layout, formulas and formatting for damages, allocation and settlement worksheets.",
    body: `# Damages and settlement tables

## Layout
- One header row, frozen; one record per row; no merged cells inside the data range; no blank rows inside the range.
- Inputs (facts) and calculations in separate, clearly labeled columns; assumptions (rates, caps, multipliers) in a labeled assumptions block or sheet, referenced by formula, never hard-coded inside a row.
- Totals in a single totals row below the data (or a summary sheet), computed with SUM/SUBTOTAL over the whole column range so added rows are captured.

## Formulas
- Prefer transparent formulas over pasted values; every derived cell should trace back to inputs (trace_precedents confirms this).
- Round only for display (number format), not in the formula, unless the allocation rules require rounding at a step; then round explicitly with ROUND and note it.
- Guard divisions: IF(denominator=0, "", numerator/denominator).
- Dates as real dates (not text); durations with DATEDIF or subtraction formatted as a number.

## Formatting
- Currency columns: accounting or currency format with two decimals, negatives in parentheses; percentages as percent with one decimal.
- Left-align text, right-align numbers; header row bold with a light fill; totals row bold with a top border.
- Column widths fit the longest realistic value; wrap long text columns instead of widening past ~60 characters.
- Do not color-code meaning without a legend; do not rely on color alone.

## Checks before finishing
- Column totals reconcile with any figure quoted in the memo or letter.
- No #REF!, #VALUE!, #DIV/0! or #NAME? anywhere (find_cells for error values after edits).
- Row counts match the source list (claimants, invoices, bills).
- Note the data source and as-of date in a header or notes cell.`,
  },
  {
    id: "mdl-status-deck",
    title: "MDL / mass tort status deck",
    apps: ["slides"],
    summary: "Slide order and content for a litigation status update to partners or clients.",
    body: `# MDL / mass tort status deck

Audience: partners or clients who need the state of the litigation in ten minutes. Every slide answers "what changed and what happens next".

## Slide order
1. Title: matter name, court and judge, date of the update, presenter.
2. Snapshot: case count (filed / pending / dismissed), where cases sit (federal MDL, state coordinated proceedings), bellwether status, next key date. Four to six figures, large type.
3. Procedural posture: recent orders (case management, Daubert, summary judgment) with dates and one-line outcomes.
4. Timeline: past milestones and upcoming dates on one horizontal timeline (filing, consolidation, discovery close, expert deadlines, bellwether trials, settlement conferences).
5. Science and experts: status of general causation experts and any rulings; keep to conclusions, not the argument.
6. Discovery: document production status, key depositions taken and scheduled.
7. Settlement or resolution track: negotiations, mediation, any program terms in outline.
8. Risks and decisions needed: what the audience must decide, with a recommendation.
9. Next 90 days: dated action list with owners.
10. Appendix: detailed schedules, order list with ECF numbers, glossary.

## Content rules
- One message per slide; a title that states the takeaway ("Bellwether 1 set for March 2026; 3 of 4 Daubert motions denied").
- Six bullets maximum, each one line; numbers with units and as-of dates.
- Cite the source of any figure in a footer line (ECF number, order date, docket report).
- Use the firm template's theme; no clip art; charts only when the number matters more than the sentence.
- Confidentiality footer on every slide when the deck contains work product or settlement information.`,
  },
  {
    id: "case-timeline",
    title: "Case timeline",
    apps: ["slides", "writer", "sheets"],
    summary: "How to build a clear chronology as a table, a slide timeline or a diagram.",
    body: `# Case timeline

## As a table (Writer or Sheets)
Columns: Date | Event | Source (ECF no., Bates range, deposition page:line) | Significance. One event per row, sorted ascending; dates in a single format (Mar. 4, 2021 or 2021-03-04) throughout. Approximate dates flagged as such ("c. 2019", "spring 2020").

## As a slide timeline (Slides)
- Horizontal axis, left-to-right, five to nine milestones per slide; split into eras across slides if more.
- Each milestone: a short date label above the axis and a one-line event below; highlight the current date or the next deadline.
- Future events in a lighter tint than past events; deadlines in the accent color.
- Keep text at 14 pt or larger; if labels collide, drop to fewer milestones rather than shrinking type.

## As a diagram (render_diagram)
- Graphviz with rankdir=LR draws a clean chronology: one node per event ("Mar 2021\\nMDL formed"), edges in order, shape=box, style=rounded.
- Mermaid "timeline" or "gantt" also work for a quick draft; export as an image and place it with the app's insert step.

## Sources
- Every event needs a source you can point to; unsourced items are marked "[source needed]" rather than dropped silently.`,
  },
  {
    id: "firm-style",
    title: "Firm writing and formatting style",
    apps: ["writer", "sheets", "slides"],
    summary: "House conventions for memos, letters and client-facing material.",
    body: `# Firm writing and formatting style

## Voice
- Direct and plain. Short sentences, active voice, concrete nouns. No hedging stacks ("it may perhaps be possible").
- Lead with the conclusion, then the reasons, then the detail.
- Define a term once, then use it consistently. Avoid Latin where English works (use "among other things", not "inter alia", outside quotations).

## Memos
- Header block: TO, FROM, DATE, RE, and a privilege line when applicable.
- Sections: Question Presented, Brief Answer, Facts, Discussion (with numbered headings), Conclusion and Recommendation.
- Headings in title case; body 12 pt serif (Times New Roman or the template's face), 1.0 or 1.15 spacing, 1-inch margins, page numbers centered in the footer.

## Letters
- Firm letterhead template; date, delivery method line (Via Email), recipient block, Re: line in bold, salutation with a colon, closing "Sincerely," and signature block with direct dial and email.

## Spreadsheets
- A "Notes" or "README" sheet stating source, as-of date and the meaning of any flags.
- Consistent number formats per column; no formulas replaced by values without a note.

## Decks
- Firm theme; takeaway titles; footers with matter short name, date, and confidentiality legend; slide numbers on.

## Always
- Protect PHI and privileged material: no client identifiers in filenames or slide footers unless required; check redactions before export.`,
  },
];

export function listFirmGuides(): Array<Pick<FirmGuide, "id" | "title" | "apps" | "summary">> {
  return GUIDES.map(({ id, title, apps, summary }) => ({ id, title, apps, summary }));
}

export function getFirmGuide(id: string): FirmGuide | null {
  return GUIDES.find((g) => g.id === id) ?? null;
}
