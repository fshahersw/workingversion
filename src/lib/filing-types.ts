// Client-safe classification + cleanup for raw PACER-style docket text.

export const FILING_TYPES = [
  "Order",
  "Case Management Order",
  "Motion",
  "Complaint",
  "Answer",
  "Brief",
  "Notice",
  "Stipulation",
  "Transcript",
  "Minute Entry",
  "Letter",
  "Exhibit",
  "Affidavit / Declaration",
  "Judgment",
  "Subpoena",
  "Summons",
  "Certificate",
  "Other",
] as const;

export type FilingType = (typeof FILING_TYPES)[number];

const RULES: [FilingType, RegExp][] = [
  ["Case Management Order", /case management order|scheduling order|\bcmo\b|pretrial order/i],
  ["Judgment", /\bjudgment\b|final judgment|verdict/i],
  ["Order", /\border\b|\bordered\b|opinion and order|memorandum opinion/i],
  ["Motion", /\bmotion\b|\bmotions?\b|petition to|application for/i],
  ["Complaint", /\bcomplaint\b|petition\b|short form complaint/i],
  ["Answer", /\banswer\b|\bresponse to\b|opposition to/i],
  ["Brief", /\bbrief\b|memorandum of law|reply memorandum/i],
  ["Transcript", /transcript/i],
  ["Minute Entry", /minute entry|minute order|text only entry/i],
  ["Stipulation", /stipulation|joint stipulation|agreed order/i],
  ["Subpoena", /subpoena/i],
  ["Summons", /summons/i],
  ["Affidavit / Declaration", /affidavit|declaration of/i],
  ["Certificate", /certificate of|certification/i],
  ["Exhibit", /\bexhibit\b|attachment/i],
  ["Letter", /^letter|\bletter\b/i],
  ["Notice", /\bnotice\b/i],
];

const LEADING: [FilingType, RegExp][] = [
  ["Motion", /^\s*(?:amended\s+|joint\s+|unopposed\s+)?motion\b/i],
  ["Notice", /^\s*notice\b/i],
  ["Letter", /^\s*letter\b/i],
  ["Order", /^\s*(?:text\s+)?order\b/i],
  ["Case Management Order", /^\s*case management order|^\s*scheduling order/i],
  ["Transcript", /^\s*transcript\b/i],
  ["Complaint", /^\s*(?:short form\s+)?complaint\b/i],
  ["Answer", /^\s*answer\b/i],
  ["Stipulation", /^\s*stipulation\b/i],
  ["Brief", /^\s*brief\b/i],
  ["Minute Entry", /^\s*minute (?:entry|order)\b/i],
];

export function classifyFiling(description: string): FilingType {
  for (const [type, re] of LEADING) if (re.test(description)) return type;
  for (const [type, re] of RULES) if (re.test(description)) return type;
  return "Other";
}

const ENTERED = /\(Entered:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\)?/;
// Truncated tails such as "(Entered: 12/18/" appear in the source data.
const ENTERED_PARTIAL = /\(Entered:[^)]*\)?\s*$/i;
const RELATES = /this (?:order|document|filing) relates to[\s\S]*$/i;
const CASE_REF = /\d{1,2}:\d{2}-[a-z]{2,3}-\d{3,6}(?:-[A-Z]{2,4})?/g;

export type ParsedFiling = {
  /** Description with the entered-date and the relates-to tail removed. */
  text: string;
  /** ISO date parsed out of "(Entered: MM/DD/YYYY)", when present. */
  enteredAt: string | null;
  /** The stripped "relates to case numbers" tail, if any. */
  relatesTo: string | null;
  /** Distinct member-case docket numbers named in the relates-to tail. */
  relatedCaseNumbers: string[];
};

const pad = (v: string) => v.padStart(2, "0");

export function parseFiling(raw: string): ParsedFiling {
  let text = raw ?? "";
  let enteredAt: string | null = null;

  const m = ENTERED.exec(text);
  if (m) {
    enteredAt = `${m[3]}-${pad(m[1]!)}-${pad(m[2]!)}`;
    text = text.replace(ENTERED, "");
  }
  text = text.replace(ENTERED_PARTIAL, "");

  let relatesTo: string | null = null;
  const rel = RELATES.exec(text);
  if (rel) {
    relatesTo = rel[0].trim();
    text = text.replace(RELATES, "");
  }

  const relatedCaseNumbers = relatesTo ? [...new Set(relatesTo.match(CASE_REF) ?? [])] : [];

  return {
    text: text.replace(/\s+/g, " ").replace(/[\s;,.]+$/, "").trim() || "Docket entry",
    enteredAt,
    relatesTo,
    relatedCaseNumbers,
  };
}
