// ============================================================================
// Deterministic Bluebook citation checker (pure; no model, no network).
//
// Scans plain text for the citation forms that appear in litigation drafts
// (case reporters, Westlaw/LEXIS cites, U.S.C. / C.F.R. / federal rules,
// "Id." short forms, signals, pinpoints) and reports concrete, rule-cited
// findings with a suggested replacement the caller can apply verbatim via
// find & replace. It is a formatting checker, not a validity checker: it does
// not know whether a case exists (see verify_citations for that) or whether a
// proposition is supported.
//
// Design rules:
//  - Flag only what a mechanical rule settles (reporter abbreviation and
//    spacing, ordinal form, "§ " spacing, month abbreviations inside a
//    citation parenthetical, missing court/year parenthetical).
//  - Every finding carries the Bluebook rule it rests on and a suggestion that
//    is a pure string substitution of `found`.
//  - Never guess a court or a year. A missing parenthetical is reported, not
//    invented.
// ============================================================================

export type FindingKind =
  | "reporter"
  | "ordinal"
  | "parenthetical"
  | "court"
  | "id"
  | "signal"
  | "pinpoint"
  | "statute"
  | "rule"
  | "month";

export type Severity = "error" | "warning" | "info";

export type Finding = {
  kind: FindingKind;
  severity: Severity;
  /** Exact text as it appears in the input (safe to use as a find string). */
  found: string;
  /** Drop-in replacement for `found`, when the fix is mechanical. */
  suggestion?: string;
  /** Bluebook rule or table the finding rests on. */
  rule: string;
  message: string;
  /** Character offset of `found` in the input. */
  offset: number;
  /** Number of times `found` occurs in the input (for expectedOccurrences). */
  occurrences: number;
};

export type CaseCitation = {
  text: string;
  volume: string;
  reporter: string;
  page: string;
  pin?: string;
  parenthetical?: string;
  year?: string;
  offset: number;
};

export type BluebookReport = {
  citations: CaseCitation[];
  findings: Finding[];
  summary: string;
};

// --- Reporter table (Bluebook T1 / R6.1) ------------------------------------
//
// Canonical form + the variants a draft is likely to contain. Spacing follows
// R6.1(a): adjacent single capitals close up (U.S., F.3d, N.E.2d, A.3d) while
// abbreviations with a multi-letter part are spaced (S. Ct., F. Supp. 2d,
// L. Ed. 2d, Cal. Rptr. 3d, So. 2d, F. App'x). Ordinals (2d, 3d, 4th) count as
// single capitals for that rule.

type ReporterSpec = {
  canonical: string;
  /** Kind of court the reporter publishes, used for the parenthetical check. */
  court: "scotus" | "appeals" | "district" | "state" | "other";
  variants: string[];
};

const REPORTERS: ReporterSpec[] = [
  { canonical: "U.S.", court: "scotus", variants: ["U. S.", "US", "U.S"] },
  { canonical: "S. Ct.", court: "scotus", variants: ["S.Ct.", "S. Ct", "S.Ct", "Sup. Ct."] },
  {
    canonical: "L. Ed. 2d",
    court: "scotus",
    variants: ["L.Ed.2d", "L. Ed.2d", "L.Ed. 2d", "L. Ed 2d"],
  },
  { canonical: "L. Ed.", court: "scotus", variants: ["L.Ed.", "L. Ed"] },
  { canonical: "F.4th", court: "appeals", variants: ["F. 4th", "F.4th.", "F4th", "F. 4th."] },
  {
    canonical: "F.3d",
    court: "appeals",
    variants: ["F. 3d", "F.3d.", "F3d", "F. 3rd", "F.3rd", "F. 3d."],
  },
  { canonical: "F.2d", court: "appeals", variants: ["F. 2d", "F.2d.", "F2d", "F. 2nd", "F.2nd"] },
  {
    canonical: "F. App'x",
    court: "appeals",
    variants: [
      "Fed. Appx.",
      "Fed. App'x",
      "F. Appx.",
      "F.App'x",
      "Fed.Appx.",
      "F. App’x",
      "Fed. App’x",
    ],
  },
  {
    canonical: "F. Supp. 3d",
    court: "district",
    variants: ["F.Supp.3d", "F. Supp.3d", "F.Supp. 3d", "F. Supp 3d", "F. Supp. 3d.", "F.Supp.3d."],
  },
  {
    canonical: "F. Supp. 2d",
    court: "district",
    variants: ["F.Supp.2d", "F. Supp.2d", "F.Supp. 2d", "F. Supp 2d", "F. Supp. 2d.", "F.Supp.2d."],
  },
  { canonical: "F. Supp.", court: "district", variants: ["F.Supp.", "F. Supp", "F.Supp"] },
  { canonical: "F.R.D.", court: "district", variants: ["F. R. D.", "F.R.D", "FRD"] },
  { canonical: "B.R.", court: "other", variants: ["B. R.", "Bankr."] },
  { canonical: "Fed. Cl.", court: "other", variants: ["Fed.Cl."] },
  { canonical: "A.3d", court: "state", variants: ["A. 3d", "A.3d.", "A. 3rd"] },
  { canonical: "A.2d", court: "state", variants: ["A. 2d", "A.2d.", "A. 2nd"] },
  { canonical: "N.E.3d", court: "state", variants: ["N.E. 3d", "N. E. 3d", "N.E.3d."] },
  { canonical: "N.E.2d", court: "state", variants: ["N.E. 2d", "N. E. 2d", "N.E.2d."] },
  { canonical: "N.W.3d", court: "state", variants: ["N.W. 3d", "N. W. 3d"] },
  { canonical: "N.W.2d", court: "state", variants: ["N.W. 2d", "N. W. 2d"] },
  { canonical: "P.3d", court: "state", variants: ["P. 3d", "P.3d.", "P. 3rd"] },
  { canonical: "P.2d", court: "state", variants: ["P. 2d", "P.2d.", "P. 2nd"] },
  { canonical: "S.E.2d", court: "state", variants: ["S.E. 2d", "S. E. 2d"] },
  { canonical: "S.W.3d", court: "state", variants: ["S.W. 3d", "S. W. 3d"] },
  { canonical: "S.W.2d", court: "state", variants: ["S.W. 2d", "S. W. 2d"] },
  { canonical: "So. 3d", court: "state", variants: ["So.3d", "So. 3d.", "So.3d."] },
  { canonical: "So. 2d", court: "state", variants: ["So.2d", "So. 2d.", "So.2d."] },
  {
    canonical: "Cal. Rptr. 3d",
    court: "state",
    variants: ["Cal.Rptr.3d", "Cal. Rptr.3d", "Cal.Rptr. 3d"],
  },
  {
    canonical: "Cal. Rptr. 2d",
    court: "state",
    variants: ["Cal.Rptr.2d", "Cal. Rptr.2d", "Cal.Rptr. 2d"],
  },
  { canonical: "N.Y.S.3d", court: "state", variants: ["N.Y.S. 3d", "N. Y. S. 3d"] },
  { canonical: "N.Y.S.2d", court: "state", variants: ["N.Y.S. 2d", "N. Y. S. 2d"] },
  { canonical: "N.J. Super.", court: "state", variants: ["N.J.Super.", "N.J. Super"] },
  { canonical: "N.J.", court: "state", variants: ["N. J."] },
  { canonical: "Cal. 5th", court: "state", variants: ["Cal.5th"] },
  { canonical: "Cal. 4th", court: "state", variants: ["Cal.4th"] },
  { canonical: "N.Y.3d", court: "state", variants: ["N.Y. 3d"] },
  { canonical: "N.Y.2d", court: "state", variants: ["N.Y. 2d"] },
  { canonical: "WL", court: "other", variants: [] },
  {
    canonical: "U.S. Dist. LEXIS",
    court: "district",
    variants: ["U.S.Dist.LEXIS", "US Dist LEXIS", "U.S. Dist. Lexis"],
  },
  {
    canonical: "U.S. App. LEXIS",
    court: "appeals",
    variants: ["U.S.App.LEXIS", "US App LEXIS", "U.S. App. Lexis"],
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest variants first so "F. Supp. 3d" wins over "F. Supp." */
const REPORTER_ALTERNATION = REPORTERS.flatMap((r) => [r.canonical, ...r.variants])
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  // a literal space in a variant may be any run of whitespace in the text
  .map((v) => v.replace(/\\? /g, "\\s+"))
  .join("|");

const CANONICAL_BY_FORM = new Map<string, ReporterSpec>();
for (const r of REPORTERS) {
  CANONICAL_BY_FORM.set(norm(r.canonical), r);
  for (const v of r.variants) CANONICAL_BY_FORM.set(norm(v), r);
}
function norm(form: string): string {
  return form.replace(/\s+/g, " ").replace(/’/g, "'").trim();
}

/** Canonical Bluebook form for a reporter abbreviation as typed, or null. */
export function normalizeReporter(raw: string): string | null {
  return CANONICAL_BY_FORM.get(norm(raw))?.canonical ?? null;
}

// volume  reporter  page[, pin]  [(parenthetical)]
// The pin group also admits the wrong "at p. 12" / "at pp. 12-13" so it can be
// reported rather than silently cutting the citation short.
const CASE_CITE_RE = new RegExp(
  String.raw`\b(\d{1,4})\s+(${REPORTER_ALTERNATION})\s+(\d{1,6})((?:\s*,\s*(?:at\s+(?:pp?\.\s*)?)?(?:\*?\d{1,6}(?:\s*[-–]\s*\*?\d{1,6})?|n\.\s*\d+))*)(\s*\(([^()]{2,120})\))?`,
  "g",
);

const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/;
const CIRCUIT_RE = /\b(?:\d{1,2}(?:st|d|th)|Fed\.|D\.C\.)\s*Cir\./;
const DISTRICT_RE =
  /\b(?:[NSEWCM]\.\s?)?D\.\s?[A-Z]|\bD\.\s?(?:Md|Del|Mass|Conn|Minn|Colo|Nev|Ariz|Kan|Neb|Utah|Idaho|Or|Mont|Wyo|Alaska|Haw|Me|Vt|R\.I|N\.J|N\.H|N\.M|S\.C|P\.R|V\.I|D\.C)\b/;

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

function push(findings: Finding[], text: string, f: Omit<Finding, "occurrences">): void {
  if (f.suggestion !== undefined && f.suggestion === f.found) return;
  // one finding per distinct `found` string: the fix is a find & replace
  if (findings.some((x) => x.found === f.found && x.kind === f.kind)) return;
  findings.push({ ...f, occurrences: countOccurrences(text, f.found) });
}

/** Months as Bluebook T12 abbreviates them inside citations. */
const MONTHS: Record<string, string> = {
  January: "Jan.",
  February: "Feb.",
  March: "Mar.",
  April: "Apr.",
  May: "May",
  June: "June",
  July: "July",
  August: "Aug.",
  September: "Sept.",
  October: "Oct.",
  November: "Nov.",
  December: "Dec.",
  "Sep.": "Sept.",
  "Jun.": "June",
  "Jul.": "July",
  Sept: "Sept.",
  Jan: "Jan.",
  Feb: "Feb.",
  Mar: "Mar.",
  Apr: "Apr.",
  Aug: "Aug.",
  Oct: "Oct.",
  Nov: "Nov.",
  Dec: "Dec.",
};

function checkMonths(paren: string, parenOffset: number, text: string, findings: Finding[]): void {
  const re =
    /\b(January|February|March|April|June|July|August|September|October|November|December|Sep\.|Jun\.|Jul\.|Sept|Jan|Feb|Mar|Apr|Aug|Oct|Nov|Dec)(?=\s+\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paren))) {
    const found = m[1]!;
    const canon = MONTHS[found];
    if (!canon || canon === found) continue;
    push(findings, text, {
      kind: "month",
      severity: "warning",
      found,
      suggestion: canon,
      rule: "T12",
      message: `Inside a citation, abbreviate the month as "${canon}".`,
      offset: parenOffset + m.index,
    });
  }
}

function checkCaseCitations(text: string, citations: CaseCitation[], findings: Finding[]): void {
  CASE_CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CASE_CITE_RE.exec(text))) {
    const [full, volume, reporterRaw, page, pins, parenGroup, parenInner] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string | undefined,
    ];
    const spec = CANONICAL_BY_FORM.get(norm(reporterRaw));
    if (!spec) continue;
    const canonical = spec.canonical;
    const offset = m.index;
    const year = parenInner ? YEAR_RE.exec(parenInner)?.[1] : undefined;
    citations.push({
      text: full,
      volume,
      reporter: canonical,
      page,
      ...(pins.trim() ? { pin: pins.replace(/^\s*,\s*/, "").trim() } : {}),
      ...(parenInner ? { parenthetical: parenInner } : {}),
      ...(year ? { year } : {}),
      offset,
    });

    // 1. Reporter abbreviation / spacing (R6.1(a), T1). The find string is the
    //    whole "volume reporter page" head so a replace-all can never touch a
    //    neighbouring reporter that shares a prefix ("F. Supp" inside "F. Supp. 2d").
    if (norm(reporterRaw) !== canonical) {
      const isOrdinal = /\b(2nd|3rd)\b/.test(reporterRaw);
      const headEnd = full.length - pins.length - (parenGroup?.length ?? 0);
      const head = full.slice(0, headEnd);
      push(findings, text, {
        kind: isOrdinal ? "ordinal" : "reporter",
        severity: "error",
        found: head,
        suggestion: head.replace(reporterRaw, canonical),
        rule: isOrdinal ? "R6.2(b)(iii)" : "R6.1(a), T1",
        message: isOrdinal
          ? `Bluebook ordinals are "2d" and "3d", never "2nd"/"3rd": write "${canonical}".`
          : `Reporter abbreviation should read "${canonical}" (single capitals close up; multi-letter parts are spaced).`,
        offset,
      });
    }

    // 2. Pinpoint written as "at p. 12" / "pp." (R3.2(a))
    const pinBad = /,\s*at\s+pp?\.\s*\*?\d+(?:\s*[-–]\s*\*?\d+)?/.exec(pins);
    if (pinBad) {
      const found = pinBad[0];
      push(findings, text, {
        kind: "pinpoint",
        severity: "error",
        found,
        suggestion: found.replace(/\s+pp?\.\s*/, " "),
        rule: "R3.2(a)",
        message: 'Pinpoint pages are bare numbers after "at" — no "p." or "pp.".',
        offset: offset + full.indexOf(found),
      });
    }

    // 3. Court / year parenthetical (R10.4, R10.5). WL/LEXIS need a full date.
    if (canonical === "WL" || canonical.endsWith("LEXIS")) {
      if (!parenInner) {
        push(findings, text, {
          kind: "parenthetical",
          severity: "error",
          found: full,
          rule: "R10.8.1, R18.3.1",
          message:
            "An unreported (WL/LEXIS) citation needs a parenthetical with the court and the full decision date, e.g. (S.D.N.Y. Mar. 3, 2024).",
          offset,
        });
      } else {
        if (!YEAR_RE.test(parenInner)) {
          push(findings, text, {
            kind: "parenthetical",
            severity: "error",
            found: `(${parenInner})`,
            rule: "R10.5(a), R18.3.1",
            message:
              "The parenthetical of an unreported decision must give the full date, including the year.",
            offset: offset + full.indexOf(`(${parenInner})`),
          });
        }
        checkMonths(parenInner, offset + full.indexOf(parenInner), text, findings);
      }
      continue;
    }
    if (!parenInner) {
      push(findings, text, {
        kind: "parenthetical",
        severity: "warning",
        found: full,
        rule: "R10.4, R10.5",
        message:
          spec.court === "scotus"
            ? "A Supreme Court citation needs a year parenthetical, e.g. (2015). (Not flagged when this is a short form or the parenthetical follows a later pinpoint.)"
            : "A full case citation needs a court-and-year parenthetical, e.g. (9th Cir. 2021) or (S.D.N.Y. 2020). Skip if this is a short form.",
        offset,
      });
      continue;
    }
    if (!YEAR_RE.test(parenInner)) {
      push(findings, text, {
        kind: "parenthetical",
        severity: "error",
        found: `(${parenInner})`,
        rule: "R10.5(a)",
        message: "The court/year parenthetical is missing the decision year.",
        offset: offset + full.indexOf(`(${parenInner})`),
      });
    }
    if (spec.court === "appeals" && !CIRCUIT_RE.test(parenInner)) {
      push(findings, text, {
        kind: "court",
        severity: "warning",
        found: `(${parenInner})`,
        rule: "R10.4(a), T7",
        message: `A ${canonical} citation should name the circuit, e.g. (2d Cir. ${year ?? "YEAR"}); ordinals are 1st, 2d, 3d, 4th…`,
        offset: offset + full.indexOf(`(${parenInner})`),
      });
    }
    if (spec.court === "district" && !DISTRICT_RE.test(parenInner) && !/Bankr\./.test(parenInner)) {
      push(findings, text, {
        kind: "court",
        severity: "warning",
        found: `(${parenInner})`,
        rule: "R10.4(a), T7",
        message: `A ${canonical} citation should name the district, e.g. (D.N.J. ${year ?? "YEAR"}) or (N.D. Cal. ${year ?? "YEAR"}).`,
        offset: offset + full.indexOf(`(${parenInner})`),
      });
    }
    if (spec.court === "scotus" && /\bU\.S\.\s*(?:Sup\.\s*Ct\.|Supreme Court)/i.test(parenInner)) {
      push(findings, text, {
        kind: "court",
        severity: "warning",
        found: `(${parenInner})`,
        suggestion: year ? `(${year})` : undefined,
        rule: "R10.4(a)",
        message:
          "For U.S. Reports and S. Ct. citations the parenthetical is the year alone; the court is implied by the reporter.",
        offset: offset + full.indexOf(`(${parenInner})`),
      });
    }
    checkMonths(parenInner, offset + full.indexOf(parenInner), text, findings);
  }
}

function checkShortForms(text: string, findings: Finding[]): void {
  let m: RegExpExecArray | null;
  // "Id at 12" — period missing (R4.1). Only when a locator follows, so prose
  // such as "the id at the top" is never touched.
  const noPeriod = /\b([Ii]d) at(?=\s+(?:\d|¶|§|n\.))/g;
  while ((m = noPeriod.exec(text))) {
    push(findings, text, {
      kind: "id",
      severity: "error",
      found: m[0],
      suggestion: `${m[1]}. at`,
      rule: "R4.1",
      message: '"Id." takes a period: "Id. at 12".',
      offset: m.index,
    });
  }
  // "Id., at 12" — stray comma (R4.1)
  const comma = /\b([Ii]d)\.\s*,\s*at\b/g;
  while ((m = comma.exec(text))) {
    push(findings, text, {
      kind: "id",
      severity: "error",
      found: m[0],
      suggestion: `${m[1]}. at`,
      rule: "R4.1",
      message: 'No comma between "Id." and "at": "Id. at 12".',
      offset: m.index,
    });
  }
  const ibid = /\b[Ii]bid\.?/g;
  while ((m = ibid.exec(text))) {
    push(findings, text, {
      kind: "id",
      severity: "error",
      found: m[0],
      suggestion: m[0][0] === "I" ? "Id." : "id.",
      rule: "R4.1",
      message: 'The Bluebook uses "Id.", never "Ibid."',
      offset: m.index,
    });
  }
}

function checkSignals(text: string, findings: Finding[]): void {
  // "See e.g." / "See, e.g." missing commas (R1.2, R1.3)
  const seeEg = /\b(See|see|But see|but see|Cf\.|cf\.)(,?)\s+e\.g\.(,?)(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = seeEg.exec(text))) {
    const [found, sig, c1, c2] = m as unknown as [string, string, string, string];
    if (c1 === "," && c2 === ",") continue;
    push(findings, text, {
      kind: "signal",
      severity: "error",
      found,
      suggestion: `${sig}, e.g.,`,
      rule: "R1.2(a)",
      message: 'Write the signal as "See, e.g.," — a comma on each side of "e.g.".',
      offset: m.index,
    });
  }
  const cf = /\b(Cf|cf)(?=\s+[A-Z0-9])/g;
  while ((m = cf.exec(text))) {
    if (text[m.index + 2] === ".") continue;
    push(findings, text, {
      kind: "signal",
      severity: "error",
      found: m[1]!,
      suggestion: `${m[1]}.`,
      rule: "R1.2(a)",
      message: 'The signal is "Cf." with a period.',
      offset: m.index,
    });
  }
}

function checkStatutesAndRules(text: string, findings: Finding[]): void {
  let m: RegExpExecArray | null;
  // § immediately followed by a digit (R6.2(c): space after § and §§)
  const sect = /(§§?)(\d[\w.()-]*)/g;
  while ((m = sect.exec(text))) {
    push(findings, text, {
      kind: "statute",
      severity: "error",
      found: `${m[1]}${m[2]}`,
      suggestion: `${m[1]} ${m[2]}`,
      rule: "R6.2(c)",
      message: `Put a space between "${m[1]}" and the section number.`,
      offset: m.index,
    });
  }
  const codes: Array<[RegExp, string, string]> = [
    [/\bUSC\b(?!\.)/g, "U.S.C.", "T1"],
    [/\bU\.S\.C\b(?!\.)/g, "U.S.C.", "T1"],
    [/\bCFR\b(?!\.)/g, "C.F.R.", "T1"],
    [/\bC\.F\.R\b(?!\.)/g, "C.F.R.", "T1"],
    [/\bFRCP\b/g, "Fed. R. Civ. P.", "R12.9.3"],
    [/\bF\.R\.C\.P\.?/g, "Fed. R. Civ. P.", "R12.9.3"],
    [/\bFed\.R\.Civ\.P\./g, "Fed. R. Civ. P.", "R12.9.3"],
    [/\bFRE\b/g, "Fed. R. Evid.", "R12.9.3"],
    [/\bF\.R\.E\.?(?=\s+\d)/g, "Fed. R. Evid.", "R12.9.3"],
    [/\bFed\.R\.Evid\./g, "Fed. R. Evid.", "R12.9.3"],
    [/\bFRAP\b/g, "Fed. R. App. P.", "R12.9.3"],
    [/\bFed\.R\.App\.P\./g, "Fed. R. App. P.", "R12.9.3"],
    [/\bFed\. Reg\b(?!\.)/g, "Fed. Reg.", "T1"],
  ];
  for (const [re, canon, rule] of codes) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m[0] === canon) continue;
      push(findings, text, {
        kind: /Fed\. R\./.test(canon) ? "rule" : "statute",
        severity: "error",
        found: m[0],
        suggestion: canon,
        rule,
        message: `Abbreviate as "${canon}".`,
        offset: m.index,
      });
    }
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Check a passage (or a whole document's plain text) for Bluebook form.
 * `maxFindings` bounds the report so a long brief never floods the model.
 */
export function checkBluebook(text: string, opts?: { maxFindings?: number }): BluebookReport {
  const max = Math.max(1, Math.min(200, opts?.maxFindings ?? 60));
  const input = String(text ?? "").replace(/\u00a0/g, " ");
  const citations: CaseCitation[] = [];
  const findings: Finding[] = [];
  checkCaseCitations(input, citations, findings);
  checkShortForms(input, findings);
  checkSignals(input, findings);
  checkStatutesAndRules(input, findings);
  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.offset - b.offset,
  );
  const trimmed = findings.slice(0, max);
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const summary =
    findings.length === 0
      ? `${citations.length} case citation${citations.length === 1 ? "" : "s"} scanned; no Bluebook form issues found.`
      : `${citations.length} case citation${citations.length === 1 ? "" : "s"} scanned; ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${
          findings.length > trimmed.length
            ? ` (showing ${trimmed.length} of ${findings.length})`
            : ""
        }.`;
  return { citations, findings: trimmed, summary };
}
