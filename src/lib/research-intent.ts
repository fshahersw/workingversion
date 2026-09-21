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

/**
 * The client wraps every query in a bracketed firm/focus frame
 * (`[Seeger Weiss LLP — plaintiffs' mass tort ... Research focus: ...]\n\n<text>`,
 * see orchestrate.ts frameQuery). That frame contains "litigation" and runs
 * ~30 words, so classifying the framed string makes EVERY input look like a
 * long legal question — "hello" then triggers the full tool loop. Strip the
 * frame before any heuristic looks at the text; the prompt still receives it.
 */
export function stripQueryFrame(query: string): string {
  const q = query ?? "";
  const m = q.match(/^\s*\[([^\]\n]{0,400})\]\s*\n*/);
  // Only the FIRM frame is a frame. An attorney's own leading bracket
  // ("[MDL 3080] bellwether schedule") is part of the question and carries its
  // most distinctive anchor, so it must survive.
  if (!m || !/research\s+focus\s*:/i.test(m[1] ?? "")) return q.trim();
  const rest = q.slice(m[0].length).trim();
  // A frame with nothing after it is not a frame, it is the whole question.
  return rest || q.trim();
}

/** The trailing `[Clarification — id: constraint]` block(s) applyChoice appends
 *  on a resume. The tool loop and the writer need them; the length/complexity
 *  heuristics must not see them, or a one-line question inflates to THINK
 *  purely because it was disambiguated. */
const CLARIFICATION_BLOCK_RE = /\s*\[\s*clarification\s*[—–-][^\]]*\]\s*/gi;

export function stripClarification(query: string): string {
  return (query ?? "").replace(CLARIFICATION_BLOCK_RE, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Document-deliverable intent — did the attorney ask for a downloadable file
// (PDF/Word/Excel report/memo), not just a chat answer? When true, the server
// renders the synthesized report into a file after synthesis (reliable), rather
// than hoping the model calls create_document mid-loop (it can't, once it has
// entered the tool-less synthesis phase).
// ---------------------------------------------------------------------------
export type DocStyle = "legal" | "modern" | "minimal";
export type DocRequest = { wants: boolean; format: "pdf" | "docx" | "xlsx"; style: DocStyle; pages?: number };

// ONE definition of "the attorney named a file format / asked for a file /
// asked to stay in chat", shared with the clarification detectors
// (agents/clarify.ts). Two copies drifted apart once and produced a question
// the panel never asked plus a PDF nobody wanted.
export const DOC_FORMAT_RE = /\b(pdf|word\s?doc(?:ument)?s?|word\s+file|docx|\.docx?|excel|spread\s?sheets?|xlsx|\.xlsx?)\b/i;
/** "in Word" / "as a Word doc": the product, so a capital W is required —
 *  lowercase "in a word, yes" is an idiom, not a format. */
export const DOC_WORD_PRODUCT_RE = /\b(?:in|as)\s+(?:a\s+)?Word\b/;
export const DOC_VERB_RE = /\b(generate|create|make|draft|produce|build|prepare|assemble|put together|write[- ]?up|export|turn .* into)\b/i;
export const DOC_NOUN_RE = /\b(report|memo|memorandum|one[- ]?pager|write[- ]?up|fact ?sheet|chart ?pack|packet|dossier|deliverable|document|file|workbook)\b/i;
export const CHAT_ONLY_RE =
  /\b(just\s+answer|in\s+chat(?:\s+only)?|chat\s+only|no\s+file(?:\s+needed)?|don'?t\s+generate|do\s+not\s+generate|without\s+(?:a\s+)?(?:file|document|pdf|docx))\b/i;
const DOCX_FORMAT_RE = /\b(word\s?doc(?:ument)?s?|word\s+file|docx|\.docx?)\b/i;

/** Did the text name a downloadable format (including "in Word")? */
export function mentionsDocFormat(text: string): boolean {
  return DOC_FORMAT_RE.test(text) || DOC_WORD_PRODUCT_RE.test(text);
}

export function detectDocRequest(query: string): DocRequest {
  const q = query || "";
  if (CHAT_ONLY_RE.test(q)) {
    return { wants: false, format: "pdf", style: "legal" };
  }
  const wants = mentionsDocFormat(q) || (DOC_VERB_RE.test(q) && DOC_NOUN_RE.test(q));
  let format: "pdf" | "docx" | "xlsx" = "pdf";
  if (/\b(excel|spread\s?sheets?|xlsx|\.xlsx?|workbook)\b/i.test(q)) format = "xlsx";
  else if (DOCX_FORMAT_RE.test(q) || DOC_WORD_PRODUCT_RE.test(q)) format = "docx";
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
  /\b(shorten (that|it|this)|make (that|it|this) (shorter|longer|a table|into a table|more concise|more formal)|too long|tl;?dr|rephrase (that|it)|reword (that|it)|rewrite (that|it)|say (that|it) again|in plain (english|terms)|simplify (that|it)|bullet(ize| points| that)|summari[sz]e (that|this|the above|your (last )?answer)|(as|in) (a table|bullets?|\d+ bullets?|one (paragraph|sentence)|two sentences|plain english)|key (points|takeaways) (of|from) (that|this|the above)|translate (that|this|it)|who are you|what can you do|what are you|how do you work)\b/i;

/** Any hint that this is a real legal-research question — blocks a down-route. */
const LEGAL_SIGNAL_RE =
  /\b(mdl|jpml|docket|cmo|pto|bellwether|pacer|court|circuit|opinion|ruling|holding|motion|order|settle(ment)?|class(\s|-)?(cert|action)?|rule ?\d|daubert|preemption|fda|recall|statute|limitations|repose|v\.|et al|plaintiff|defendant|deposition|complaint|filing|litigation|lawsuit|damages|injur|causation|liab|remand|removal|discovery|subpoena|expert|verdict|appeal|trials?|cases?|claims?|hearings?|schedule|updates?|latest|pending|status)\b/i;

/** Multi-part / comparative / strategic phrasing -> think. */
const THINK_RE =
  /\b(compare|contrast|versus|vs\.?|cross[- ]?reference|relationship between|analyze|analysis|assess(ment)?|comprehensive|walk me through|deep dive|breakdown|all (the|of)|every |both |strateg|implications|pros and cons|as well as|and also)\b/i;

/** True when the query carries any legal-research signal (the down-route veto). */
export function hasLegalSignal(query: string): boolean {
  return LEGAL_SIGNAL_RE.test(stripClarification(stripQueryFrame(query || "")));
}

/**
 * Classify how much effort a turn deserves. Pure heuristic, zero latency.
 * `historyTurns` is the count of prior turns (a fresh first turn is never
 * conversational, since there is no prior answer to reformat/acknowledge).
 */
export function classifyEffort(query: string, historyTurns = 0): EffortDecision {
  const q = stripClarification(stripQueryFrame(query || ""));
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
