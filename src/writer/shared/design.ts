/**
 * Firm design system for the Office assistants. Hexes are the app's own brand
 * tokens (src/styles.css oklch values converted to sRGB) so documents match the
 * product. Colors are 6-digit hex without '#', the convention every Writer
 * command and table preset already uses.
 */
export const FIRM_PALETTE = {
  navy: "172E4C",
  blue: "1D6294",
  bronze: "A77D4B",
  ink: "050F2C",
  slate: "5F6A7B",
  rule: "DDE0E4",
  navyTint: "E2ECF9",
  blueTint: "D8EBFB",
  blueSoft: "EAF5FF",
  bronzeTint: "FCF2E4",
  paper: "FFFFFF",
} as const;

const P = FIRM_PALETTE;

/**
 * Appended to the Writer system prompt in Edit mode. One brief, no user
 * setting: the assistant reads the document type and applies the matching
 * look itself (court filings stay plain; memos and client work get the firm
 * palette).
 */
export const DESIGN_BRIEF = [
  "# Design",
  "User requirements come first: preserve explicitly requested heading levels, names, fonts, colors, page geometry and table structure. Design defaults apply only where the user left a choice open. A request for a Heading 1 section stays level 1 even when the document also has a title; do not demote it to make a preferred hierarchy.",
  "For a new document, choose a restrained, readable look from its purpose. For editing or polishing an existing document, preserve its theme and unrelated formatting unless the user requests a restyle. Small text edits do not authorize global design changes.",
  `Palette (hex, no #): navy ${P.navy} for headings and table headers; blue ${P.blue} for subheadings, links and emphasis; ` +
    `bronze ${P.bronze} as the single accent (a callout rule, one key figure); tints ${P.navyTint} / ${P.blueTint} / ${P.bronzeTint} for table bands and callout fills; ` +
    `slate ${P.slate} for captions and secondary text; rules ${P.rule}. Body text stays ${P.ink} (near black).`,
  `Typography: H1 18 pt bold navy; H2 14 pt bold navy; H3 12 pt bold blue; body 11 pt with 1.15 line spacing and 6 pt after; captions 9 pt slate. When you build or restyle a memo, report or client document, apply the heading colors with updateTextStyle on docHeading (color ${P.navy} for levels 1-2, ${P.blue} for level 3).`,
  "Tables: use insert_table and preserve requested styling and structure. When creating a new table and the user left its design open, consider firmNavy for data and comparison tables, firmBlue for schedules, chronologies and status tables, " +
    "firmAccent to spotlight one key table, firmMinimal for filings and dense financial tables. Bold header row; right-align numbers; units in the header, not in every cell; " +
    "prefer at most 7 columns only when that accommodates all requested data; never drop columns to meet a style preference. Set colWidths deliberately. Preserve existing table styles unless a restyle is requested.",
  "Callouts: put a key takeaway, holding or recommendation in a <blockquote> (indent + left bar) with its first phrase in <strong>. Never use <pre> for prose.",
  "Document types: internal memos and research summaries use navy headings and firmNavy tables; client deliverables and reports use a clear title and restrained hierarchy. Add a separate cover page only when requested or present in the selected template; never invent a date, client or matter. " +
    "court filings, pleadings and letters to a court stay black text with no fills and firmMinimal tables, keep the document's existing fonts and spacing, and give caption pages, tables of contents and authorities, signature blocks and certificates of service their own pages.",
  "Page geometry comes first: on a new or restructured document, set the page (set_page_setup applyTo 'all', or apply_court_style for a filing) BEFORE inserting content, so tables, images and columns are sized to the text area you will actually have; a table is never wider than the text area (set_table_properties widthPercent 100 or autoFit window).",
  "Structure over appearance: headings are Heading styles (setHeadingLevel), never a bold paragraph; body and citation text is black; one alignment for body text and one per heading level; whitespace comes from paragraph spacing and page breaks, never from runs of empty paragraphs; one footnote definition per authority (insert_footnote once, Id./supra after).",
  "Finish: compare the resulting content and structure against each explicit user requirement, including exact heading levels, row counts, numbers and scope. audit_document lists structural issues; it cannot prove compliance with the request or factual accuracy. For visual questions (overflow, page balance, spacing) use view_page. Give a short receipt of actual changes and any unresolved limitation, without repeating tool-by-tool narration.",
].join("\n");
