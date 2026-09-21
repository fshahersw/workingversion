// ============================================================================
// Composer placeholder: a quiet, human nudge derived from context the chat
// view already holds (the active matter's label, the last question's named
// subject). Pure and deterministic; no storage, no network, no tracking.
//
// Rules: use LABELS only (a matter name, a proper-noun anchor from the user's
// own question), never raw sensitive text; keep it short; never repeat the
// previous placeholder back to back; rotate through a small set that
// refreshes every couple of days so it stays fresh without feeling random.
// Falls back to the classic prompt when there is no context.
// ============================================================================

export type PlaceholderContext = {
  /** active matter label (MatterScope.label) */
  matterLabel?: string | null;
  /** the user's most recent question in this chat */
  lastQuestion?: string | null;
  /** turns so far in this chat (drives rotation) */
  turnCount: number;
  /** the placeholder currently shown (never repeated back to back) */
  previous?: string | null;
  now?: Date;
};

export const DEFAULT_PLACEHOLDER = "Ask a follow-up about MDLs, bellwethers, or precedent…";

const TOPIC_TEMPLATES: readonly string[] = [
  "Still on {T}?",
  "Back to {T}?",
  "Anything else on {T}?",
  "Want to see if anything changed in {T}?",
  "{T} again? I had a feeling.",
  "One more pass at {T}?",
  "Should we keep going on {T}?",
  "Want to compare our {T} findings against more research?",
  "Sticking with {T}? Say so and I'll lock it in.",
  "Still chasing the cleanest citation on {T}?",
  "Where does {T} go from here?",
];

const MATTER_TEMPLATES: readonly string[] = [
  "Back to {M}?",
  "Anything new in {M} since you were here?",
  "Still working {M}? Where to next?",
  "Want to see if anything changed in {M}?",
  "One more question on {M}?",
  "{M}: what should we check next?",
];

const GENERIC_TEMPLATES: readonly string[] = [
  DEFAULT_PLACEHOLDER,
  "What's the next question on your mind?",
  "Still chasing the cleanest citation?",
  "One more pass at the regulatory timeline?",
  "A chronology, a memo, a comparison — what are we building?",
  "Back to the causation issue from earlier?",
  "Which matter are we in today?",
];

const SENTENCE_OPENERS = new Set(
  "what when where which who whom why how is are was were did does do has have had can could should would will give find list summarize explain tell show compare draft write please the a an in on for to of and or any latest current recent status update about does".split(" "),
);
/** Words that never form a subject on their own ("the Judge", "In re"). */
const ROLE_WORDS = new Set(["judge", "court", "honorable", "hon", "mdl", "jccp", "no", "in", "re", "v", "vs"]);
/** Trailing connectives dropped from a run ("Roundup In" -> "Roundup"); "Zantac MDL" and "Third Circuit" keep their suffix. */
const TRAILING_DROP = new Set(["in", "re", "v", "vs", "no"]);

/**
 * A short, capitalized subject from the user's own question ("Zantac MDL",
 * "Roundup", "Judge Chhabria", "MDL 2738"), or null. Proper nouns only: no
 * sentence openers, at most three words, at most 32 characters.
 */
export function topicFromQuestion(question: string | null | undefined): string | null {
  if (!question) return null;
  const q = question.replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  if (!q) return null;
  const mdl = /\b((?:MDL|JCCP)\s*(?:No\.?\s*)?\d{3,5})\b/i.exec(q);
  if (mdl) return mdl[1]!.replace(/\s+/g, " ").toUpperCase().replace("NO.", "No.");
  const words = q.split(" ");
  let best: string[] = [];
  let run: string[] = [];
  const flush = () => {
    while (run.length && TRAILING_DROP.has(run[run.length - 1]!.toLowerCase().replace(/[^a-z]/g, ""))) run.pop();
    if (run.length > best.length && run.some((w) => !ROLE_WORDS.has(w.toLowerCase()))) best = run;
    run = [];
  };
  words.forEach((raw, i) => {
    const w = raw.replace(/^[("'“]+|[)"',;:?!.”]+$/g, "");
    const isCap = /^[A-Z][A-Za-z0-9&.'’-]{1,}$/.test(w) || /^[A-Z]{2,}$/.test(w);
    const opener = i === 0 && SENTENCE_OPENERS.has(w.toLowerCase());
    if (isCap && !opener && !SENTENCE_OPENERS.has(w.toLowerCase())) {
      if (run.length < 3) run.push(w);
      else flush();
    } else flush();
  });
  flush();
  if (!best.length) return null;
  const label = best.join(" ");
  if (label.length > 32 || label.length < 3) return null;
  return label;
}

/** Deterministic small hash for rotation. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Seeded pick of `n` distinct templates: the set a user sees for a couple of days. */
function rollingSet(pool: readonly string[], seed: number, n: number): string[] {
  const idx = pool.map((_, i) => i);
  let s = seed || 1;
  for (let i = idx.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, Math.min(n, pool.length)).map((i) => pool[i]!);
}

export function composerPlaceholder(ctx: PlaceholderContext): string {
  const now = ctx.now ?? new Date();
  const dayBucket = Math.floor(now.getTime() / (2 * 86_400_000)); // refreshes every two days
  const matter = (ctx.matterLabel ?? "").trim();
  const topic = topicFromQuestion(ctx.lastQuestion);
  // Prefer the last question's subject when it is not simply the matter itself.
  const subject = topic && (!matter || !matter.toLowerCase().includes(topic.toLowerCase())) ? topic : null;
  let pool: readonly string[];
  let fill: (t: string) => string;
  if (subject) {
    pool = TOPIC_TEMPLATES;
    fill = (t) => t.replace("{T}", subject);
  } else if (matter) {
    pool = MATTER_TEMPLATES;
    fill = (t) => t.replace("{M}", matter);
  } else {
    pool = GENERIC_TEMPLATES;
    fill = (t) => t;
  }
  const seed = hash(`${dayBucket}:${matter}:${subject ?? ""}`);
  const set = rollingSet(pool, seed, 7).map(fill);
  let i = (ctx.turnCount + dayBucket) % set.length;
  if (set[i] === ctx.previous) i = (i + 1) % set.length;
  return set[i] ?? DEFAULT_PLACEHOLDER;
}
