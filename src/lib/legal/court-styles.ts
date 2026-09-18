// ============================================================================
// Court formatting profiles for filings (pure catalog).
//
// Each profile captures the typography a court's rules impose on filed briefs
// (typeface class, body and footnote size, line spacing, margins, paper) with
// the rule it rests on. The catalog is deliberately short: only rules whose
// text is stable and widely applied are included, and every profile carries a
// verification note — local rules change, and individual judges add standing
// orders. The Writer's `apply_court_style` tool applies a profile through the
// ordinary formatting commands; nothing here is a substitute for reading the
// current rule before filing.
// ============================================================================

export type MarginsIn = { top: number; right: number; bottom: number; left: number };

export type CourtStyle = {
  id: string;
  label: string;
  /** Rule(s) the profile is drawn from. */
  source: string;
  /** Typeface the rule requires or a common compliant choice; `fontRequired`
   *  says whether the family itself is mandated (true) or only its class. */
  fontFamily: string;
  fontRequired: boolean;
  fontClass: string;
  bodySizePt: number;
  footnoteSizePt: number;
  /** Multiplier as Word uses it: 2 = double, 1.5 = one-and-a-half, 1 = single. */
  lineSpacing: number;
  /** Text that may stay single-spaced under the rule (informational). */
  singleSpacedExceptions: string[];
  marginsIn: MarginsIn;
  paper: "letter" | "legal" | "a4" | "booklet";
  notes: string[];
};

const ONE_INCH: MarginsIn = { top: 1, right: 1, bottom: 1, left: 1 };

const VERIFY =
  "Confirm against the current rule text, the court's local rules, and any individual judge's standing orders before filing.";

export const COURT_STYLES: readonly CourtStyle[] = [
  {
    id: "frap",
    label: "U.S. Courts of Appeals (FRAP 32)",
    source: "Fed. R. App. P. 32(a)(4)–(6)",
    fontFamily: "Century Schoolbook",
    fontRequired: false,
    fontClass:
      "proportionally spaced serif, 14-point or larger (sans-serif permitted only in headings and captions)",
    bodySizePt: 14,
    footnoteSizePt: 14,
    lineSpacing: 2,
    singleSpacedExceptions: ["quotations more than two lines long", "headings", "footnotes"],
    marginsIn: ONE_INCH,
    paper: "letter",
    notes: [
      "8½ × 11 inch paper; text on one side only.",
      "Circuit local rules may add or tighten requirements (some circuits specify body/footnote sizes or word limits by type).",
      VERIFY,
    ],
  },
  {
    id: "scotus-booklet",
    label: "Supreme Court of the United States — booklet format (Rule 33.1)",
    source: "Sup. Ct. R. 33.1",
    fontFamily: "Century Schoolbook",
    fontRequired: true,
    fontClass:
      "Century family (e.g., Century Expanded, New Century Schoolbook, Century Schoolbook)",
    bodySizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 1,
    singleSpacedExceptions: [],
    marginsIn: { top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 },
    paper: "booklet",
    notes: [
      "Booklet format is 6⅛ × 9¼ inches with text on both sides; the page size is not applied here (Writer paper is letter/legal/A4). Use this profile for typeface and sizes only.",
      "Text is set with at least 2-point leading; the rule is expressed in typographic terms rather than a Word line-spacing multiplier.",
      VERIFY,
    ],
  },
  {
    id: "scotus-8x11",
    label: "Supreme Court of the United States — 8½ × 11 format (Rule 33.2)",
    source: "Sup. Ct. R. 33.2",
    fontFamily: "Century Schoolbook",
    fontRequired: false,
    fontClass: "12-point type; Century family conventional",
    bodySizePt: 12,
    footnoteSizePt: 12,
    lineSpacing: 2,
    singleSpacedExceptions: ["indented quotations", "footnotes"],
    marginsIn: ONE_INCH,
    paper: "letter",
    notes: [
      "For documents the Rules permit on 8½ × 11 paper (e.g., in forma pauperis filings and certain applications).",
      VERIFY,
    ],
  },
  {
    id: "sdny-edny",
    label: "S.D.N.Y. / E.D.N.Y. (Local Civil Rule 11.1)",
    source: "S.D.N.Y. & E.D.N.Y. Local Civil Rule 11.1(b)",
    fontFamily: "Times New Roman",
    fontRequired: false,
    fontClass: "12-point text (footnotes 10-point)",
    bodySizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 2,
    singleSpacedExceptions: ["headings", "footnotes", "block quotations"],
    marginsIn: ONE_INCH,
    paper: "letter",
    notes: [
      "8½ × 11 inch paper; text double-spaced.",
      "Many S.D.N.Y. judges impose individual practices (page limits, fonts). Check the assigned judge's rules.",
      VERIFY,
    ],
  },
  {
    id: "cal-superior",
    label: "California Superior Courts (Cal. Rules of Court 2.100 series)",
    source: "Cal. Rules of Court, rules 2.104, 2.107, 2.108",
    fontFamily: "Times New Roman",
    fontRequired: false,
    fontClass: "not smaller than 12-point",
    bodySizePt: 12,
    footnoteSizePt: 12,
    lineSpacing: 2,
    singleSpacedExceptions: ["headings", "footnotes", "quotations"],
    marginsIn: { top: 1, right: 0.5, bottom: 1, left: 1 },
    paper: "letter",
    notes: [
      "Lines may be one-and-a-half or double spaced (rule 2.108); double is applied here.",
      "Pleading paper with consecutive line numbers in the left margin is required (rule 2.108) and is not applied by this tool.",
      VERIFY,
    ],
  },
  {
    id: "conservative-default",
    label: "Conservative default (no specific court rule)",
    source: "Firm convention; not a court rule",
    fontFamily: "Times New Roman",
    fontRequired: false,
    fontClass: "12-point serif",
    bodySizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 2,
    singleSpacedExceptions: ["headings", "footnotes", "block quotations"],
    marginsIn: ONE_INCH,
    paper: "letter",
    notes: [
      "A widely accepted federal district court layout; replace with the forum's local rule as soon as it is known.",
      VERIFY,
    ],
  },
];

export function findCourtStyle(id: string): CourtStyle | null {
  const key = String(id ?? "")
    .trim()
    .toLowerCase();
  return COURT_STYLES.find((s) => s.id === key) ?? null;
}

export function listCourtStyles(): Array<Pick<CourtStyle, "id" | "label" | "source">> {
  return COURT_STYLES.map(({ id, label, source }) => ({ id, label, source }));
}

/** A one-paragraph description the tool returns so the model can explain what it did. */
export function describeCourtStyle(style: CourtStyle): string {
  const m = style.marginsIn;
  const margins =
    m.top === m.right && m.right === m.bottom && m.bottom === m.left
      ? `${m.top}" all sides`
      : `top ${m.top}", right ${m.right}", bottom ${m.bottom}", left ${m.left}"`;
  const spacing =
    style.lineSpacing === 2
      ? "double"
      : style.lineSpacing === 1.5
        ? "1.5"
        : style.lineSpacing === 1
          ? "single"
          : `${style.lineSpacing}×`;
  return [
    `${style.label} — ${style.source}.`,
    `Typeface: ${style.fontFamily}${style.fontRequired ? " (required family)" : ` (${style.fontClass})`}; body ${style.bodySizePt} pt, footnotes ${style.footnoteSizePt} pt; ${spacing}-spaced` +
      (style.singleSpacedExceptions.length
        ? ` (single spacing allowed for ${style.singleSpacedExceptions.join(", ")})`
        : "") +
      `; margins ${margins}; ${style.paper} paper.`,
    ...style.notes,
  ].join(" ");
}
