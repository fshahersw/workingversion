/**
 * Deterministic fact-check pass (research quality item 7).
 *
 * Extracts the specifics litigators care about — dates, MDL/docket numbers,
 * dollar figures, CFR/USC cites, case names — from the streamed answer and
 * verifies each appears verbatim in the retrieved source corpus. Anything not
 * found is surfaced as "confirm on the docket" rather than silently trusted.
 */
import type { Source } from "./chat-types";

export type CheckKind =
  | "mdl"
  | "docket"
  | "date"
  | "amount"
  | "cite"
  | "case";

export type FactClaim = {
  value: string;
  kind: CheckKind;
  verified: boolean;
};

const PATTERNS: { kind: CheckKind; re: RegExp }[] = [
  { kind: "mdl", re: /\bMDL\s*(?:No\.?\s*)?\d{3,4}\b/gi },
  { kind: "docket", re: /\b\d{1,2}:\d{2}-[a-z]{2,4}-\d{3,6}\b/gi },
  { kind: "cite", re: /\b\d{1,2}\s+(?:U\.?S\.?C\.?|C\.?F\.?R\.?)\s*§*\s*[\d.]+[a-z]?\b/gi },
  { kind: "amount", re: /\$\s?\d[\d,.]*\s?(?:billion|million|thousand|B|M|K)?\b/gi },
  {
    kind: "date",
    re: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+(?:19|20)\d{2}\b/gi,
  },
  { kind: "case", re: /\bIn re[:]?\s+[A-Z][A-Za-z0-9'.\-&]*(?:\s+[A-Z][A-Za-z0-9'.\-&]*){0,6}/g },
];

const KIND_LABEL: Record<CheckKind, string> = {
  mdl: "MDL number",
  docket: "Docket number",
  date: "Date",
  amount: "Figure",
  cite: "Citation",
  case: "Case name",
};

export function kindLabel(k: CheckKind) {
  return KIND_LABEL[k];
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/[§.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip markdown emphasis/links so extraction sees plain prose. */
function plain(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, " ");
}

export function factCheck(answer: string, sources: Source[]): FactClaim[] {
  if (!answer.trim() || sources.length === 0) return [];
  const corpus = normalize(
    sources
      .map((s) => `${s.citation ?? ""} ${s.section_path ?? ""} ${s.content ?? ""}`)
      .join(" \n "),
  );
  const body = plain(answer);
  const out: FactClaim[] = [];
  const seen = new Set<string>();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of body.matchAll(re)) {
      const raw = match[0].trim().replace(/[.,;:]$/, "");
      const key = `${kind}:${normalize(raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: raw, kind, verified: corpus.includes(normalize(raw)) });
    }
  }
  return out;
}

export function unverified(claims: FactClaim[]) {
  return claims.filter((c) => !c.verified);
}

export type CitationCheck = {
  /** [S#] refs the answer actually cited. */
  cited: string[];
  /** Cited refs with NO matching retrieved source — an invented citation. */
  orphans: string[];
  /** Retrieved sources the answer never cited. */
  unused: string[];
};

/** Deterministic [S#] integrity: every citation marker in the answer must map to
 *  a real retrieved source. Tolerant of ref format (compares the numeric part). */
export function checkCitations(answer: string, sources: Source[]): CitationCheck {
  const refNums = new Set(
    sources.map((s) => (s.ref ?? "").replace(/\D/g, "")).filter(Boolean),
  );
  const citedNums = new Set(
    [...answer.matchAll(/\[S(\d+)\]/gi)].map((m) => m[1] as string),
  );
  return {
    cited: [...citedNums].map((n) => `S${n}`),
    orphans: [...citedNums].filter((n) => !refNums.has(n)).map((n) => `S${n}`),
    unused: [...refNums].filter((n) => !citedNums.has(n)).map((n) => `S${n}`),
  };
}
