// ============================================================================
// Pure context-budget helpers for research-agent memory.
//
// Shared by the browser (use-chat builds the outbound tail) and the server
// (memory.server normalizes and renders it), so this module has NO server
// imports and no model calls. Everything here is deterministic and cheap.
// ============================================================================

export type TailTurn = { role: "user" | "assistant"; content: string };

// --- Tail budget -----------------------------------------------------------
//
// The verbatim tail is what keeps a follow-up grounded in the exact wording
// of the last exchanges (the rolling summary is lossy). It is also the most
// expensive part of the memory in tokens, so it is budgeted two ways: a hard
// turn cap and a character budget. When the budget binds, OLDER messages are
// trimmed first and harder, so the most recent exchange always arrives intact.

/** Max question/answer pairs kept verbatim. */
export const TAIL_MAX_TURNS = 4;
/** Max chars for the newest message of each role (verbatim). */
export const TAIL_RECENT_CHARS = 4000;
/** Older assistant answers are long; keep their head only. */
export const TAIL_OLDER_ASSISTANT_CHARS = 1500;
/** Older user questions are short; keep them nearly whole. */
export const TAIL_OLDER_USER_CHARS = 1200;
/** Total character budget for the whole tail (~2.5k tokens). */
export const TAIL_BUDGET_CHARS = 10_000;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Fit a chronological tail to the turn cap and character budget.
 * Keeps the newest messages, trims older ones harder, drops from the front
 * when the total still exceeds the budget. Never reorders.
 */
export function fitTail(
  tail: readonly TailTurn[],
  opts?: {
    maxTurns?: number;
    budgetChars?: number;
    recentChars?: number;
    olderAssistantChars?: number;
    olderUserChars?: number;
  },
): TailTurn[] {
  const maxTurns = opts?.maxTurns ?? TAIL_MAX_TURNS;
  const budget = opts?.budgetChars ?? TAIL_BUDGET_CHARS;
  const recentChars = opts?.recentChars ?? TAIL_RECENT_CHARS;
  const olderA = opts?.olderAssistantChars ?? TAIL_OLDER_ASSISTANT_CHARS;
  const olderU = opts?.olderUserChars ?? TAIL_OLDER_USER_CHARS;

  const cleaned = tail
    .filter(
      (t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
    )
    .map((t) => ({ role: t.role, content: t.content.trim() }))
    .filter((t) => t.content.length > 0)
    .slice(-maxTurns * 2);

  // Newest message per role is "recent"; everything older is trimmed harder.
  let lastUser = -1;
  let lastAssistant = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const t = cleaned[i]!;
    if (t.role === "user" && lastUser < 0) lastUser = i;
    if (t.role === "assistant" && lastAssistant < 0) lastAssistant = i;
    if (lastUser >= 0 && lastAssistant >= 0) break;
  }

  let out: TailTurn[] = cleaned.map((t, i) => {
    const recent = i === lastUser || i === lastAssistant;
    const cap = recent ? recentChars : t.role === "assistant" ? olderA : olderU;
    return { role: t.role, content: clip(t.content, cap) };
  });

  // Drop from the front (oldest) until the total fits the budget, but never
  // drop the most recent exchange.
  const total = () => out.reduce((n, t) => n + t.content.length, 0);
  while (out.length > 2 && total() > budget) out = out.slice(1);
  if (out.length && total() > budget) {
    // Two messages still over budget: clip the older one to what remains.
    const newest = out[out.length - 1]!;
    const room = Math.max(200, budget - newest.content.length);
    out =
      out.length === 2
        ? [{ role: out[0]!.role, content: clip(out[0]!.content, room) }, newest]
        : [newest];
  }
  return out;
}

// --- Standalone-question detection -----------------------------------------
//
// resolveQuestion() rewrites a follow-up into a standalone query with a model
// call that sits ON the critical path (before routing and retrieval). Most
// follow-ups that name their subject need no rewrite, so a deterministic
// pre-check skips the call when the question carries no referential language.
// Conservative by design: any hint of anaphora or ellipsis keeps the rewrite.

const ANAPHORA_RE =
  /\b(it|its|itself|that|this|these|those|there|therein|thereof|they|them|their|theirs|he|she|his|her|hers|him|himself|herself|same|above|aforementioned|earlier|previous|previously|prior|latter|former|again|also|too|either|both|such|said|likewise|instead|respectively)\b/i;

/** Elliptical openers that only make sense against prior context. Bare
 *  interrogatives (when/where/who/why) are NOT listed: a full question that
 *  names its subject is standalone; the short-question and anaphora rules
 *  catch the elliptical ones ("When is it?", "Who is the judge?"). */
const ELLIPSIS_RE =
  /^\s*(?:\[[^\]]*\]\s*)*(?:and|but|or|so|also|what about|how about|what else|anything else|any (?:update|news|developments?|change)s?|more on|expand|elaborate|go deeper|dig deeper|how so|how come|which one|same for|do the same|now|next|then|ok(?:ay)?|yes|no|sure|thanks?)\b/i;

/**
 * Definite references to legal roles/objects WITHOUT a proper noun or number
 * nearby ("the judge", "the order", "the MDL") point back into the conversation.
 */
const DEFINITE_ROLE_RE =
  /\bthe\s+(?:judge|court|case|matter|mdl|jccp|order|ruling|opinion|motion|brief|defendant|plaintiff|party|parties|filing|docket|hearing|trial|settlement|expert|witness|deposition|statute|rule|complaint|appeal|verdict|jury|class|claim|litigation)s?\b(?!\s+(?:of|in|for|no\.?|number|#)\s*[A-Z0-9])/i;

/** A capitalized word that is not a sentence opener, or an MDL/docket number. */
const PROPER_NOUN_RE =
  /(?:^|[\s(])(?!(?:What|When|Where|Which|Who|Why|How|Is|Are|Was|Were|Did|Does|Do|Has|Have|Can|Could|Should|Would|Will|Give|Find|List|Summarize|Explain|Tell|Show|Compare|Draft|Write|Please|The|A|An|In|On|For|To|Of|And|Or|Any|Latest|Current|Recent|Status|Update)\b)[A-Z][a-zA-Z0-9.&'’-]{2,}/;
const MDL_OR_DOCKET_RE =
  /\b(?:MDL|JCCP)\s*(?:No\.?\s*)?\d{3,5}\b|\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}\b|\bNo\.\s*\d{2}-\d{2,6}\b/i;

/** Strip a leading client frame like "[Seeger Weiss LLP — …]\n\n". */
function stripFrame(q: string): string {
  return q.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
}

/**
 * True when the question likely depends on prior turns and should be rewritten
 * to standalone before routing/retrieval. False when it is self-contained, in
 * which case the rewrite model call is skipped (topicShift stays false, so the
 * established ledger is kept — the safe default).
 */
export function needsResolution(question: string): boolean {
  const q = stripFrame(question);
  if (!q) return false;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length <= 5) return true;
  if (ELLIPSIS_RE.test(q)) return true;
  if (ANAPHORA_RE.test(q)) return true;
  const hasAnchor = MDL_OR_DOCKET_RE.test(q) || PROPER_NOUN_RE.test(q);
  if (!hasAnchor) return true;
  if (DEFINITE_ROLE_RE.test(q)) {
    // "the judge in the Roundup MDL" is anchored; "the judge's latest order" is not.
    // Anchored questions with a definite role are common ("What did the court
    // hold in Zantac?"); only treat as referential when no anchor is present in
    // the same clause.
    const clauses = q.split(/[,;:?.]|\b(?:and|but|or)\b/i);
    for (const c of clauses) {
      if (DEFINITE_ROLE_RE.test(c) && !(MDL_OR_DOCKET_RE.test(c) || PROPER_NOUN_RE.test(c)))
        return true;
    }
  }
  return false;
}
