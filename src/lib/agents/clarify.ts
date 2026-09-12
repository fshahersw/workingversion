/**
 * Pre-flight clarification for litigation research.
 *
 * Ask only when 2–5 clear alternatives exist, the choice materially changes
 * the research, and the system cannot infer the answer from the question or
 * the conversation so far. Detection is deterministic (microseconds, no model).
 * One question per turn. Always a recommended default.
 *
 * Resume, don't restart: the client re-sends the original question with a
 * ChoiceAnswer; applyChoice() appends a constraint the tool loop can trust.
 *
 * A bad question costs more than a missing one: it stalls the turn and tells
 * the attorney the tool does not understand their matter. Every detector
 * therefore requires (a) an explicit fork trigger, (b) a real matter to fork
 * over, and (c) no evidence the fork is already settled — including the
 * `[Clarification — <id>: …]` marker the client carries forward on the turn
 * where the fork was answered.
 */
import type { ChoiceAnswer, ChoiceRequest } from "../chat-types.ts";
import {
  CHAT_ONLY_RE,
  DOC_NOUN_RE,
  DOC_VERB_RE,
  mentionsDocFormat,
  stripClarification,
  stripQueryFrame,
} from "../research-intent.ts";

export type ClarifyContext = {
  query: string;
  /** Prior user/assistant text plus entity labels, used to skip settled forks. */
  context?: string;
};

/** Trial-timing / forum forks. Deliberately NOT "which court is handling X" or
 *  "state or federal" — those are factual questions to answer, not forks to
 *  hand back to the attorney. */
const FORUM_ASK_RE =
  /\b(?:next\s+(?:bellwether\s+)?trial|bellwether\s+schedule|trial\s+(?:date|schedule|setting)s?|when\s+is\s+(?:the\s+)?(?:next\s+)?trial|where\s+(?:will|is)\s+(?:the\s+)?trial|coordinated\s+proceedings?)\b/i;

/** The question (or the conversation) already names the track, so there is
 *  nothing to ask: an MDL/JPML/JCCP reference, an explicit court, a county, or
 *  a federal district. */
const FORUM_SETTLED_RE =
  /\b(?:mdl\s*[- ]?\d{3,4}|mdls?|jpml|jccp|judicial\s+council|multicounty|mcc\s+proceedings?|federal\s+mdl|state[- ]court\s+coordinat(?:ed|ion)|both\s+tracks|federal\s+and\s+state|federal\s+court|state\s+court|superior\s+court|circuit\s+court|district\s+court|court\s+of\s+common\s+pleas)\b/i;

/** "Cook County", "Philadelphia County" — a named county is a state forum.
 *  Case-sensitive on purpose, so the common noun "county" does not count. */
const COUNTY_RE = /\b[A-Z][a-z]+\s+County\b/;

/** Federal district shorthand: D.N.J., S.D.N.Y., N.D. Ill., W.D. Pa., D. Mass. */
const DISTRICT_ABBR_RE =
  /\b(?:[NSEWC]\.D\.\s?(?:[A-Z]\.[A-Z]\.|[A-Z][a-z]{1,5}\.)|D\.\s?(?:[A-Z]\.[A-Z]\.|[A-Z][a-z]{1,5}\.))/;

const SOL_RE =
  /\b(statute\s+of\s+(?:limitations|repose)|statutes\s+of\s+limitations|limitations\s+period|repose\s+period|\bsol\b|tolling|discovery\s+rule|date\s+of\s+accrual)\b/i;

/** The attorney already asked for a multi-state answer (including the phrasing
 *  the /sol and /intake skills compose). */
const SOL_SURVEY_RE =
  /\b(50[- ]state|all\s+states|every\s+state|multi[- ]state|survey\s+(?:the\s+)?(?:key\s+)?(?:filing\s+)?states|key\s+filing\s+states|each\s+state|across\s+states|nationwide\s+survey)\b/i;

const US_STATES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington d\\.?c\\.?";

const STATE_NAME_RE = new RegExp(`\\b(?:${US_STATES})\\b`, "i");

/** Reporter-style state abbreviations. A trailing `\b` after the period never
 *  matches (a period is already a non-word char), so the boundary is a
 *  lookahead for end-of-string, whitespace, or punctuation. */
const STATE_ABBR_RE =
  /\b(?:N\.Y|N\.J|Cal|Tex|Fla|Ill|Pa|Mass|Del|Ohio|Mich|Minn|Mo|Ga|Va|Wash|Wis|Colo|Conn|Md|Nev|Okla|Ore|Tenn|Ariz|Ark|Kan|Ky|La|Neb|D\.C)\.(?=$|[\s,;:)\]}"']|\s)/;

/** Two-letter postal code used as a place: "in IL", "claims, TX", "(NJ)",
 *  "limit the analysis to IL". */
const STATE_POSTAL_RE =
  /(?:\bin|\bfor|\bunder|\bto|\bof|,|\()\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

/** In re / MDL / JCCP references — an unambiguous matter. */
const CASE_REF_RE = /\bin\s+re\b|\bmdl\s*[- ]?\d{3,4}\b|\bjccp\s*\d{0,4}\b/i;
/** A hyphenated brand ("Depo-Provera", "Camp-Lejeune") or a two-word proper
 *  span ("Bard PowerPort", "Camp Lejeune", "Hair Relaxer"). */
const HYPHEN_BRAND_RE = /\b[A-Z][a-z]+-[A-Z][a-z]+\b/;
const MULTIWORD_PROPER_RE = /\b[A-Z][A-Za-z0-9]+\s+[A-Z][A-Za-z0-9]+\b/;
/** A single proper noun sitting in litigation vocabulary: "the Suboxone
 *  litigation", "Ozempic claims". The lookbehind requires a preceding word, so
 *  a sentence-initial capital ("And the trial schedule after that?") is not
 *  mistaken for a matter name. */
const PROPER_IN_CONTEXT_RE =
  /(?<=[a-z0-9]\s)[A-Z][A-Za-z0-9]{2,}\b(?=[^.?!]{0,40}?\b(?:litigation|lawsuits?|cases?|claims?|mdl|trial|docket|settlement)\b)/;

/**
 * Procedure, doctrine, and question words that are not a matter name. A
 * doctrinal question ("How does the discovery rule work in product liability
 * cases?") is built entirely from these, so it never looks like a matter.
 */
const MATTER_STOP = new Set([
  "about", "accrual", "across", "action", "actions", "advise", "after", "against", "already",
  "analysis", "analyze", "answer", "apply", "available", "based", "because", "before",
  "bellwether", "between", "both", "brief", "case", "cases", "chat", "check", "claim", "claims",
  "class", "client", "compare", "coordinated", "could", "counsel", "court", "courts", "cover",
  "criteria", "cross", "current", "currently", "cutoff", "damages", "date", "dates", "deadline",
  "deadlines", "defect", "defective", "defendant", "defendants", "deliverable", "discovery",
  "docket", "doctrine", "document", "does", "draft", "during", "each", "every", "excel",
  "explain", "exposure", "federal", "file", "filed", "filing", "filings", "general", "generate",
  "give", "happen", "have", "hearing", "help", "here", "history", "injuries", "injury", "issue",
  "issues", "jccp", "jpml", "just", "known", "later", "latest", "lawsuit", "lawsuits", "legal",
  "liability", "limitations", "litigation", "make", "many", "matter", "memo", "memorandum",
  "most", "motion", "motions", "need", "newest", "next", "notice", "only", "order", "orders",
  "other", "outline", "over", "pending", "period", "plaintiff", "plaintiffs", "please",
  "posture", "practical", "prepare", "primary", "problem", "proceeding", "proceedings",
  "produce", "product", "products", "provide", "question", "recent", "record", "regarding",
  "relevant", "repose", "report", "review", "rule", "rules", "ruling", "rulings", "schedule",
  "schedules", "setting", "should", "since", "some", "sol", "standard", "state", "states",
  "status", "statute", "statutes", "still", "strategy", "summarize", "summary", "survey",
  "that", "their", "them", "then", "there", "these", "they", "this", "those",
  "timeline", "tolling", "tracks", "trial", "trials", "under", "update", "used", "using",
  "verdict", "were", "what", "whats", "when", "where", "which", "while", "will", "with",
  "within", "word", "work", "would", "write", "writeup", "your",
]);

/** Apostrophes removed so "When's" cannot survive as a content token. */
function normalizeForTokens(query: string): string {
  return stripClarification(stripQueryFrame(query)).replace(/['’]/g, "");
}

/**
 * Everything that can settle a fork: the question WITH any clarification block
 * it already carries (a resumed query answers its own fork, so the block must
 * survive here even though the ask triggers never see it) plus the prior turns.
 */
function settledText(input: ClarifyContext): string {
  const q = stripQueryFrame(input.query);
  const ctx = (input.context ?? "").trim();
  return ctx ? `${q}\n${ctx}` : q;
}

/** Did the attorney already answer this fork earlier in the conversation? The
 *  client carries the answer forward as a `[Clarification — <id>: …]` marker on
 *  the turn it was answered on. */
function settledByMarker(id: string, text: string): boolean {
  return new RegExp(`\\[\\s*clarification\\s*[—–-]\\s*${id}\\s*:`, "i").test(text);
}

/**
 * True when the question names a matter, product, or case at all — a loose,
 * token-based test (a lowercase substance like "paraquat" counts; doctrinal
 * vocabulary does not). Used where the matter may be a common noun.
 */
export function hasMatterCue(query: string): boolean {
  const q = normalizeForTokens(query);
  if (CASE_REF_RE.test(q)) return true;
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9$-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !MATTER_STOP.has(t));
  return tokens.length > 0;
}

/**
 * True when the question names a matter as a PROPER noun (or a case/MDL
 * reference). Required by the forum detector: a docket fork only makes sense
 * for a named litigation, and this is what keeps "When's the next trial?" and
 * doctrinal questions from being asked which court they meant.
 */
export function hasProperMatterCue(query: string): boolean {
  const q = normalizeForTokens(query);
  if (CASE_REF_RE.test(q)) return true;
  if (HYPHEN_BRAND_RE.test(q)) return true;
  if (MULTIWORD_PROPER_RE.test(q)) return true;
  return PROPER_IN_CONTEXT_RE.test(q);
}

function namesState(text: string): boolean {
  return STATE_NAME_RE.test(text) || STATE_ABBR_RE.test(text) || STATE_POSTAL_RE.test(text);
}

export function detectForum(input: ClarifyContext): ChoiceRequest | null {
  const q = normalizeForTokens(input.query);
  if (!FORUM_ASK_RE.test(q)) return null;
  if (!hasProperMatterCue(q)) return null;
  const piled = settledText(input);
  if (settledByMarker("forum", piled)) return null;
  // An explicit court, district, county, or state already picks the track.
  if (FORUM_SETTLED_RE.test(piled) || DISTRICT_ABBR_RE.test(piled) || COUNTY_RE.test(piled)) return null;
  if (STATE_NAME_RE.test(q) || STATE_ABBR_RE.test(q) || STATE_POSTAL_RE.test(q)) return null;
  return {
    id: "forum",
    prompt: "Which docket should this cover?",
    description:
      "Federal MDL and state coordinated proceedings often run on different calendars.",
    recommendedId: "both",
    allowOther: true,
    otherPlaceholder: "e.g. Illinois coordinated proceeding only",
    options: [
      {
        id: "federal",
        label: "Federal MDL",
        description: "JPML transfer, transferee court, and the MDL docket.",
      },
      {
        id: "state",
        label: "State coordinated proceedings",
        description: "JCCP, MCC, or the relevant state coordination.",
      },
      {
        id: "both",
        label: "Both tracks",
        description: "Distinguish the federal and state schedules.",
      },
    ],
  };
}

export function detectJurisdiction(input: ClarifyContext): ChoiceRequest | null {
  const q = normalizeForTokens(input.query);
  if (!SOL_RE.test(q)) return null;
  const piled = settledText(input);
  if (settledByMarker("jurisdiction", piled)) return null;
  if (namesState(piled) || SOL_SURVEY_RE.test(piled)) return null;
  if (!hasMatterCue(q)) return null;
  return {
    id: "jurisdiction",
    prompt: "Which jurisdiction should the limitations analysis use?",
    description:
      "Accrual, tolling, and repose are state-specific; a survey is slower but safer when the filing state is open.",
    recommendedId: "survey",
    allowOther: true,
    otherPlaceholder: "Name the state or states",
    options: [
      {
        id: "survey",
        label: "Survey the key states",
        description: "Compare the states where these claims are actually filed.",
      },
      { id: "california", label: "California" },
      { id: "new_york", label: "New York" },
      { id: "texas", label: "Texas" },
      { id: "florida", label: "Florida" },
    ],
  };
}

/** URLs and file names in the transcript are not the attorney asking for a
 *  format: an earlier answer citing `…/order.pdf` must not silence the panel. */
function withoutLinks(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\w-]+\.(?:pdf|docx?|xlsx?|html?)\b/gi, " ");
}

export function detectDeliverable(input: ClarifyContext): ChoiceRequest | null {
  const q = normalizeForTokens(input.query);
  if (mentionsDocFormat(q) || CHAT_ONLY_RE.test(q)) return null;
  if (!(DOC_VERB_RE.test(q) && DOC_NOUN_RE.test(q))) return null;
  const piled = withoutLinks(settledText(input));
  if (settledByMarker("deliverable", piled)) return null;
  if (mentionsDocFormat(piled) || CHAT_ONLY_RE.test(piled)) return null;
  return {
    id: "deliverable",
    prompt: "How should I deliver this?",
    description: "A file takes a deeper research pass than a chat answer.",
    recommendedId: "pdf",
    allowOther: false,
    options: [
      {
        id: "pdf",
        label: "PDF report",
        description: "Cited memo you can download and share.",
      },
      {
        id: "docx",
        label: "Word document",
        description: "Editable .docx with the same substance.",
      },
      {
        id: "chat",
        label: "Answer in chat",
        description: "No file — just the cited research here.",
      },
    ],
  };
}

const DETECTORS: Array<(input: ClarifyContext) => ChoiceRequest | null> = [
  detectForum,
  detectJurisdiction,
  detectDeliverable,
];

/** First matching detector, or null when the question is already specific. */
export function detectClarification(input: ClarifyContext): ChoiceRequest | null {
  const q = normalizeForTokens(input.query);
  if (!q) return null;
  for (const detect of DETECTORS) {
    const request = detect(input);
    if (request) return request;
  }
  return null;
}

const CONSTRAINTS: Record<string, Record<string, string>> = {
  forum: {
    federal:
      "Focus on the federal MDL (JPML transfer, transferee court, and MDL docket). Mention state coordinated proceedings only when they control or explain the federal schedule.",
    state:
      "Focus on state coordinated proceedings (JCCP, MCC, or the relevant state coordination). Mention the federal MDL only for contrast.",
    both: "Cover both the federal MDL and state coordinated proceedings. Distinguish the two tracks' schedules, presiding courts, and next trial settings. If no state coordinated proceeding exists for this litigation, say so plainly and cover the federal track only.",
  },
  jurisdiction: {
    survey:
      "Survey the key filing states for this claim type. Identify where the limitations/repose analysis actually differs, and do not treat one state's rule as national.",
    california: "Apply California limitations, repose, and tolling rules. Flag other states only as contrast.",
    new_york: "Apply New York limitations, repose, and tolling rules. Flag other states only as contrast.",
    texas: "Apply Texas limitations, repose, and tolling rules. Flag other states only as contrast.",
    florida: "Apply Florida limitations, repose, and tolling rules. Flag other states only as contrast.",
  },
  deliverable: {
    pdf: "Deliver as a PDF report after research. Do not stop at a chat-only answer.",
    docx: "Deliver as a Word document (.docx) after research. Do not stop at a chat-only answer.",
    chat: "Answer in chat only. Do not generate a downloadable file.",
  },
};

function constraintFor(answer: ChoiceAnswer): string {
  const byId = CONSTRAINTS[answer.id]?.[answer.optionId];
  if (byId) return byId;
  const extra = (answer.text ?? "").trim();
  if (answer.optionId === "other" || extra) {
    return extra || answer.label;
  }
  return answer.label;
}

/** Append a deterministic constraint so the same question resumes, not restarts. */
export function applyChoice(query: string, answer: ChoiceAnswer): string {
  const constraint = constraintFor(answer).replace(/\s+/g, " ").trim();
  if (!constraint) return query;
  if (/\[Clarification\s*[—–-]/i.test(query)) return query;
  return `${query.trim()}\n\n[Clarification — ${answer.id}: ${constraint}]`;
}

export function clarifyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|off|false|no)$/i.test((env["RESEARCH_CLARIFY"] ?? "").trim());
}

const MAX_ANSWER_CHARS = 200;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Free text goes into the query the model reads, and into the receipt the
 *  panel renders: bound its length and strip the brackets/newlines that would
 *  let it forge or break a `[Clarification — …]` block. */
function sanitize(value: string): string {
  return value.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_CHARS);
}

/** Accept a client-supplied ChoiceAnswer; reject incomplete payloads. */
export function normalizeChoiceAnswer(value: unknown): ChoiceAnswer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = sanitize(text(raw.id));
  const optionId = sanitize(text(raw.optionId) || text(raw.option_id));
  const label = sanitize(text(raw.label) || text(raw.text));
  const free = sanitize(text(raw.text));
  if (!id || !optionId) return null;
  if (optionId === "other" && !free && !label) return null;
  if (optionId !== "other" && !label && !free) return null;
  return {
    id,
    optionId,
    label: label || free,
    ...(free && free !== label ? { text: free } : optionId === "other" && free ? { text: free } : {}),
  };
}

export function contextFrom(
  history: { role: string; content: string }[] | undefined,
  entityLabels: string[] = [],
): string {
  const turns = (history ?? [])
    .map((h) => h.content)
    .filter(Boolean)
    .join("\n");
  const entities = entityLabels.filter(Boolean).join("\n");
  return [turns, entities].filter(Boolean).join("\n");
}
