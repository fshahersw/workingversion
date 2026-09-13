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
  "Have a design opinion. Choose the look from the document type and commit to it; never leave a document in default grey.",
  `Palette (hex, no #): navy ${P.navy} for headings and table headers; blue ${P.blue} for subheadings, links and emphasis; ` +
    `bronze ${P.bronze} as the single accent (a callout rule, one key figure); tints ${P.navyTint} / ${P.blueTint} / ${P.bronzeTint} for table bands and callout fills; ` +
    `slate ${P.slate} for captions and secondary text; rules ${P.rule}. Body text stays ${P.ink} (near black).`,
  `Typography: H1 18 pt bold navy; H2 14 pt bold navy; H3 12 pt bold blue; body 11 pt with 1.15 line spacing and 6 pt after; captions 9 pt slate. When you build or restyle a memo, report or client document, apply the heading colors with updateTextStyle on docHeading (color ${P.navy} for levels 1-2, ${P.blue} for level 3).`,
  "Tables: create them with insert_table and always pick a preset on purpose: firmNavy for data and comparison tables, firmBlue for schedules, chronologies and status tables, " +
    "firmAccent to spotlight one key table, firmMinimal for filings and dense financial tables. Bold header row; right-align numbers; units in the header, not in every cell; " +
    "at most 7 columns; set colWidths deliberately (first column widest when it carries labels). Restyle a bland existing table with edit_table restyle.",
  "Callouts: put a key takeaway, holding or recommendation in a <blockquote> (indent + left bar) with its first phrase in <strong>. Never use <pre> for prose.",
  "Document types: internal memos and research summaries use navy headings and firmNavy tables; client deliverables and reports add a cover page (title 28-36 pt navy, subtitle blue, date slate), one bronze accent and at most one callout per section; " +
    "court filings, pleadings and letters to a court stay black text with no fills and firmMinimal tables, keep the document's existing fonts and spacing, and give caption pages, tables of contents and authorities, signature blocks and certificates of service their own pages.",
  "After any visual change call view_page, then fix spacing, alignment, orphaned headings and column widths until the page looks finished. Name the style you applied in your closing summary.",
].join("\n");
