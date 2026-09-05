/**
 * Lightweight intent classification for litigation research queries.
 *
 * Runs client-side (no extra latency) and produces retrieval hints that are
 * merged into every orchestrate / quick-ask request body. Backends that ignore
 * the extra fields are unaffected.
 */

export type ResearchIntent =
  | "docket"
  | "causation_science"
  | "regulatory"
  | "case_law"
  | "settlement"
  | "class_cert"
  | "intake_strategy"
  | "general";

export type RetrievalHints = {
  intent: ResearchIntent;
  preferred_sources: string[];
  recency_days: number;
  focus_note: string;
};

const RULES: {
  intent: ResearchIntent;
  re: RegExp;
  sources: string[];
  recency: number;
  note: string;
}[] = [
  {
    intent: "docket",
    re: /\b(mdl|jpml|docket|cmo\b|pto\b|bellwether|transferee|case management|pacer|scheduling order|remand)\b/i,
    sources: ["pacer", "jpml", "court_dockets", "law360"],
    recency: 180,
    note: "Prioritize the live docket: MDL number, transferee judge, most recent CMO/PTO, and current bellwether schedule.",
  },
  {
    intent: "causation_science",
    re: /\b(causation|epidemiolog|study|studies|meta-analysis|daubert|rule 702|expert|biological plausibility|dose[- ]response|cohort)\b/i,
    sources: ["pubmed", "peer_reviewed", "court_opinions", "fda"],
    recency: 1825,
    note: "Prioritize peer-reviewed epidemiology and toxicology plus Rule 702/Daubert rulings addressing the same experts or methods.",
  },
  {
    intent: "regulatory",
    re: /\b(fda|recall|warning letter|maude|label(ing)?|cpsc|epa|advisory committee|510\(k\)|pma|nhtsa)\b/i,
    sources: ["fda", "cpsc", "epa", "federal_register", "nhtsa"],
    recency: 730,
    note: "Prioritize primary agency records: recall notices, warning letters, MAUDE reports, labeling changes, with exact dates.",
  },
  {
    intent: "class_cert",
    re: /\b(rule 23|class cert|certification|predominance|ascertainab|commonality|typicality)\b/i,
    sources: ["court_opinions", "westlaw", "law360"],
    recency: 1095,
    note: "Prioritize recent Rule 23 certification and decertification opinions, with circuit-level splits identified.",
  },
  {
    intent: "settlement",
    re: /\b(settle|settlement|common benefit|lien|allocation|special master|matrix|qsf)\b/i,
    sources: ["court_dockets", "settlement_agreements", "law360", "reuters_legal"],
    recency: 1095,
    note: "Prioritize the operative settlement agreement, allocation matrix, and common benefit orders; flag figures that need docket confirmation.",
  },
  {
    intent: "intake_strategy",
    re: /\b(intake|screening|criteria|fact sheet|pfs\b|checklist|workup|case evaluation|statute of (limitations|repose))\b/i,
    sources: ["court_dockets", "statutes", "practice_guides"],
    recency: 1095,
    note: "Produce operational criteria a plaintiffs' intake team can apply, including jurisdiction-specific limitations/repose deadlines.",
  },
  {
    intent: "case_law",
    re: /\b(preemption|mensing|bartlett|riegel|albrecht|holding|circuit|opinion|ruling|affirmed|reversed|summary judgment)\b/i,
    sources: ["court_opinions", "westlaw", "court_dockets"],
    recency: 1825,
    note: "Prioritize controlling authority; separate binding from persuasive holdings and note pending appeals.",
  },
];

const BASE_SOURCES = ["court_dockets", "court_opinions", "fda", "peer_reviewed"];

export function classifyIntent(query: string): RetrievalHints {
  const hit = RULES.find((r) => r.re.test(query));
  if (!hit) {
    return {
      intent: "general",
      preferred_sources: BASE_SOURCES,
      recency_days: 730,
      focus_note:
        "Prioritize primary sources over trade press; state the procedural posture and date of every authority relied on.",
    };
  }
  return {
    intent: hit.intent,
    preferred_sources: hit.sources,
    recency_days: hit.recency,
    focus_note: hit.note,
  };
}

// ---------------------------------------------------------------------------
// Effort routing — how hard should this turn work?
//
//   conversational : greeting / thanks / "who are you" / reformat-my-last-answer
//                    -> no tools, one warm direct reply. Fastest path.
//   fast           : a single scoped legal lookup -> tool loop, few steps.
//   think          : multi-part / comparative / complex -> full tool loop.
//
// Deliberately CONSERVATIVE about routing DOWN: a real legal question must never
// be answered tool-less. Conversational requires an unmistakable social/meta
// phrasing AND the absence of any legal signal; anything ambiguous defaults to
// `think` (full tools). This is the fix for "user typed thanks -> 20 searches".
// ---------------------------------------------------------------------------

export type EffortMode = "conversational" | "fast" | "think";
export type EffortDecision = { mode: EffortMode; confidence: number; reason: string };

// ---------------------------------------------------------------------------
// Document-deliverable intent — did the attorney ask for a downloadable file
// (PDF/Word/Excel report/memo), not just a chat answer? When true, the server
// renders the synthesized report into a file after synthesis (reliable), rather
// than hoping the model calls create_document mid-loop (it can't, once it has
// entered the tool-less synthesis phase).
// ---------------------------------------------------------------------------
export type DocStyle = "legal" | "modern" | "minimal";
export type DocRequest = { wants: boolean; format: "pdf" | "docx" | "xlsx"; style: DocStyle; pages?: number };

const DOC_FORMAT_RE = /\b(pdf|word\s?doc(?:ument)?s?|docx|\.docx?|excel|spread\s?sheets?|xlsx|\.xlsx?)\b/i;
const DOC_VERB_RE = /\b(generate|create|make|draft|produce|build|prepare|assemble|put together|write[- ]?up|export|turn .* into)\b/i;
const DOC_NOUN_RE = /\b(report|memo|memorandum|one[- ]?pager|write[- ]?up|fact ?sheet|chart ?pack|packet|dossier|deliverable|document|file|workbook)\b/i;

export function detectDocRequest(query: string): DocRequest {
  const q = query || "";
  const wants = DOC_FORMAT_RE.test(q) || (DOC_VERB_RE.test(q) && DOC_NOUN_RE.test(q));
  let format: "pdf" | "docx" | "xlsx" = "pdf";
  if (/\b(excel|spread\s?sheets?|xlsx|\.xlsx?|workbook)\b/i.test(q)) format = "xlsx";
  else if (/\b(word\s?doc(?:ument)?s?|docx|\.docx?)\b/i.test(q)) format = "docx";
  let style: DocStyle = "legal";
  if (/\b(modern|sleek|contemporary)\b/i.test(q)) style = "modern";
  else if (/\b(minimal|minimalist|plain|bare[- ]?bones)\b/i.test(q)) style = "minimal";
  const pm = q.match(/(\d{1,3})\s*[- ]?\s*pages?\b/i);
  const pages = pm && pm[1] ? Math.min(Math.max(parseInt(pm[1], 10), 1), 40) : undefined;
  return { wants, format, style, ...(pages ? { pages } : {}) };
}

/** Message STARTS with a social/acknowledgement opener ("thanks, that helps",
 *  "hey there", "great work"). Start-anchored, not whole-match, so trailing
 *  words don't defeat it — the !hasLegal + short-length guards keep it safe. */
const CONVERSATIONAL_RE =
  /^\s*(?:hi|hey|hello|yo|thanks|thank you|thx|ty|ok(?:ay)?|k|got it|understood|cool|nice|great|perfect|awesome|amazing|sounds good|will do|no thanks|no thank you|nvm|never ?mind|bye|goodbye|good morning|good afternoon|good evening|cheers|appreciate)\b/i;

/** Meta / reformat of the assistant's own prior answer (no new research). */
const REFORMAT_RE =
  /\b(shorten (that|it|this)|make (that|it|this) shorter|too long|tl;?dr|rephrase (that|it)|reword (that|it)|rewrite (that|it)|say (that|it) again|in plain (english|terms)|simplify (that|it)|bullet(ize| points| that)|who are you|what can you do|what are you|how do you work)\b/i;

/** Any hint that this is a real legal-research question — blocks a down-route. */
const LEGAL_SIGNAL_RE =
  /\b(mdl|jpml|docket|cmo|pto|bellwether|pacer|court|circuit|opinion|ruling|holding|motion|order|settle(ment)?|class(\s|-)?(cert|action)?|rule ?\d|daubert|preemption|fda|recall|statute|limitations|repose|v\.|et al|plaintiff|defendant|deposition|complaint|filing|litigation|lawsuit|damages|injur|causation|liab|remand|removal|discovery|subpoena|expert|verdict|appeal)\b/i;

/** Multi-part / comparative / strategic phrasing -> think. */
const THINK_RE =
  /\b(compare|contrast|versus|vs\.?|cross[- ]?reference|relationship between|analyze|analysis|assess(ment)?|comprehensive|walk me through|deep dive|breakdown|all (the|of)|every |both |strateg|implications|pros and cons|as well as|and also)\b/i;

/**
 * Classify how much effort a turn deserves. Pure heuristic, zero latency.
 * `historyTurns` is the count of prior turns (a fresh first turn is never
 * conversational, since there is no prior answer to reformat/acknowledge).
 */
export function classifyEffort(query: string, historyTurns = 0): EffortDecision {
  const q = (query || "").trim();
  if (!q) return { mode: "conversational", confidence: 0.9, reason: "empty" };
  const words = q.split(/\s+/).filter(Boolean).length;
  const questionMarks = (q.match(/\?/g) || []).length;
  const hasLegal = LEGAL_SIGNAL_RE.test(q);

  // Conversational: unmistakable social/meta/reformat, short, NO legal signal.
  // Reformat requires prior context (something to reformat); social openers do not.
  if (!hasLegal && words <= 12) {
    if (CONVERSATIONAL_RE.test(q)) {
      return { mode: "conversational", confidence: 0.95, reason: "social/acknowledgement opener" };
    }
    if (historyTurns > 0 && REFORMAT_RE.test(q)) {
      return { mode: "conversational", confidence: 0.9, reason: "reformat/meta of prior answer" };
    }
  }

  // Think: multi-part, comparative, long, or chained.
  if (THINK_RE.test(q) || questionMarks >= 2 || words >= 28 || / \band\b .+ \band\b /i.test(q)) {
    return { mode: "think", confidence: 0.8, reason: "multi-part / comparative / long" };
  }

  // Fast: a clear single scoped legal lookup (short, one ask, has a legal signal).
  if (hasLegal && questionMarks <= 1 && words <= 22) {
    return { mode: "fast", confidence: 0.7, reason: "single scoped legal lookup" };
  }

  // Default: think (full tools) — never under-serve an ambiguous real question.
  return { mode: "think", confidence: 0.5, reason: "default (ambiguous -> full tools)" };
}
