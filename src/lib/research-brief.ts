/**
 * Personalized research headlines: derive topics from the attorney's recent
 * conversation titles (not a generic legal-news firehose), then fetch a
 * handful of recent items. Prompt text is composed here so the landing page
 * never waits on a model.
 */
import { distinctiveTerms } from "./agents/web-rank.ts";

export type ResearchHeadline = {
  id: string;
  topic: string;
  title: string;
  url: string;
  source: string;
  published?: string;
  snippet: string;
  imageUrl?: string;
  why: string;
  /** Sharp, matter-specific litigator question generated for the card CTA
   *  (server enrichment); falls back to `prompt` when generation is off/fails. */
  question?: string;
  prompt: string;
  /** Which news backend produced the item. */
  backend?: HeadlineBackend;
};

const GREETING_RE = /^(hi|hello|hey|thanks|thank you|yo)\b/i;

/**
 * Capitalized words that are NOT a matter name. A conversation title is the
 * attorney's question truncated (`titleFrom` in chat/history.ts), so it almost
 * always opens on a capitalized question word or imperative verb — without this
 * list the "topic" came out as "Compare", "Summarize" or "Draft", and those
 * became the news queries.
 */
const TITLE_STOP = new Set([
  // question words and openers
  "What", "Whats", "When", "Where", "Which", "Who", "Whose", "Why", "How", "Is", "Are", "Was",
  "Were", "Do", "Does", "Did", "Can", "Could", "Should", "Would", "Will", "Has", "Have", "Any",
  "The", "This", "That", "Those", "These", "There", "Our", "Their",
  // imperative verbs attorneys open with
  "Analyze", "Assess", "Brief", "Build", "Check", "Compare", "Compile", "Confirm", "Contrast",
  "Describe", "Draft", "Explain", "Find", "Generate", "Give", "Identify", "List", "Look",
  "Make", "Outline", "Prepare", "Pull", "Research", "Review", "Show", "Summarize", "Tell",
  "Update", "Walk", "Write",
  // procedure, doctrine, and deliverable nouns
  "Bellwether", "Case", "Cases", "Claim", "Claims", "Court", "Current", "Deadline", "Deadlines",
  "Discovery", "Docket", "Federal", "Filing", "Hearing", "Latest", "Limitations", "Litigation",
  "Memo", "Motion", "Next", "Opinion", "Order", "Plaintiff", "Please", "Posture", "Report",
  "Repose", "Rule", "Ruling", "Rulings", "Schedule", "Settlement", "State", "Status", "Statute",
  "Statutes", "Timeline", "Trial", "Verdict",
  // acronyms that identify a document, not a matter
  "CMO", "PTO", "MDL", "MDLs", "JCCP", "SOL", "ECF", "PFS", "DFS",
  // honorifics
  "Judge", "Justice", "Magistrate", "Hon",
  // prepositions and connectives that survive term extraction as noise
  "Across", "About", "After", "Against", "Before", "Between", "During", "From", "Into", "Over",
  "Under", "With", "Within", "Still", "Also", "Only", "Than", "Then",
  // reporting verbs
  "Held", "Hold", "Holds", "Said", "Found", "Decided", "Denied", "Granted", "Ruled", "Issued",
  // leading words of multi-word state names, which are never a matter alone
  "New", "North", "South", "West", "East", "Rhode", "District",
]);

/** Every word that appears in a US state name, so no fragment of one ("Jersey",
 *  "Carolina") can pass as a matter. */
const STATE_WORDS = new Set(
  [
    "new", "north", "south", "west", "east", "rhode", "island", "jersey", "york", "carolina",
    "dakota", "hampshire", "mexico", "virginia", "columbia", "district",
  ],
);

/** "Judge Rodgers", "Hon. Kuhl" — the bench, not the matter. */
const HONORIFIC_NAME_RE = /\b(?:Judge|Justice|Magistrate|Hon\.?)\s+[A-Z][A-Za-z'’-]+/g;

const US_STATE_NAMES = new Set(
  [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
    "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
    "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
    "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
    "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
    "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
    "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
  ].map((s) => s.toLowerCase()),
);

const MDL_NUMBER_RE = /\bMDL\s*[- ]?\d{3,4}\b/gi;
/** "Bard PowerPort", "Camp Lejeune", "Depo-Provera Meningioma". */
const PROPER_SPAN_RE = /\b[A-Z][A-Za-z0-9]+(?:[-][A-Z][A-Za-z0-9]+)*(?:\s+[A-Z][A-Za-z0-9]+)+\b/g;
const PROPER_WORD_RE = /\b[A-Z][A-Za-z0-9]{2,}(?:[-][A-Z][A-Za-z0-9]+)*\b/g;

/** Bare single proper words that are almost never THIS firm's mass-tort matter
 *  (mega-cap tech / consumer brands). They produced generic company-news cards
 *  ("META" -> Meta-the-company trial coverage). A real matter that happens to be
 *  one of these still anchors via a multi-word span (e.g. "Tesla Autopilot"). */
const NON_MATTER = new Set([
  "meta", "facebook", "instagram", "whatsapp", "google", "alphabet", "apple",
  "amazon", "microsoft", "nvidia", "tesla", "openai", "twitter", "tiktok",
  "netflix", "uber", "lyft", "reddit", "snapchat", "youtube", "spacex", "x",
]);

const usableWord = (word: string): boolean =>
  !TITLE_STOP.has(word) &&
  !US_STATE_NAMES.has(word.toLowerCase()) &&
  !STATE_WORDS.has(word.toLowerCase()) &&
  !NON_MATTER.has(word.toLowerCase());

/** Drop leading/trailing non-name words from a proper span ("Bard PowerPort
 *  MDL" -> "Bard PowerPort"), and reject what is left of a state name. */
function trimSpan(span: string): string | null {
  const words = span.split(/\s+/);
  while (words.length && !usableWord(words[0]!)) words.shift();
  while (words.length && !usableWord(words[words.length - 1]!)) words.pop();
  if (words.length < 2) return null;
  const phrase = words.join(" ");
  return US_STATE_NAMES.has(phrase.toLowerCase()) ? null : phrase;
}

/** Proper-noun / MDL spans as they appeared in the title — better news queries
 *  than lowercased token bags ("next depo provera"). */
export function matterPhrases(title: string): string[] {
  const text = title.replace(HONORIFIC_NAME_RE, " ");
  const mdl = text.match(MDL_NUMBER_RE) ?? [];
  const spans = (text.match(PROPER_SPAN_RE) ?? [])
    .map(trimSpan)
    .filter((s): s is string => s !== null);
  const words = (text.match(PROPER_WORD_RE) ?? []).filter(usableWord);
  // A two-word product/matter span beats a single word, which beats a bare
  // MDL number; an MDL number qualifies whichever name is chosen.
  const name = spans[0] ?? words[0] ?? null;
  const number = mdl[0]?.replace(/\s+/g, " ").trim() ?? null;
  const out: string[] = [];
  if (name && number) out.push(`${name} ${number}`);
  else if (name) out.push(name);
  else if (number) out.push(number);
  return out;
}

/** Text for the fallback term extraction: no bench names, and none of the
 *  question/procedure vocabulary that would otherwise become the news query
 *  ("compare rule 702" instead of "702 hernia mesh"). */
function fallbackText(title: string): string {
  return title
    .replace(HONORIFIC_NAME_RE, " ")
    .split(/\s+/)
    .filter((w) => {
      const bare = w.replace(/[^A-Za-z0-9'’-]/g, "");
      if (!bare) return false;
      // A short standalone number is a rule or section cite ("Rule 702"), not a
      // matter; a 4-digit one is usually an MDL or JCCP number, which is.
      if (/^\d{1,3}$/.test(bare)) return false;
      const capped = bare.charAt(0).toUpperCase() + bare.slice(1);
      return !TITLE_STOP.has(capped);
    })
    .join(" ");
}

export function topicsFromTitles(titles: string[], max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of titles) {
    const title = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!title || /^new (research|conversation|chat)$/i.test(title)) continue;
    if (GREETING_RE.test(title) && title.split(/\s+/).length <= 4) continue;
    const cleaned = title.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ").replace(/\s+/g, " ").trim();
    const phrase = matterPhrases(cleaned)[0];
    // No proper name to anchor on: fall back to the distinctive terms, but only
    // when there are at least two. One generic term ("rulings") is a worse news
    // query than no card at all.
    const terms = distinctiveTerms(fallbackText(cleaned), 3);
    const topic = phrase || (terms.length >= 2 ? terms.join(" ") : "");
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
    if (out.length >= max) break;
  }
  return out;
}

export function headlinePrompt(topic: string, title: string): string {
  const t = title.replace(/\s+/g, " ").trim().slice(0, 180);
  const matter = topic.replace(/\s+/g, " ").trim().slice(0, 80);
  return `What does this development change for ${matter}? "${t}" Use the primary source and the latest docket or agency record. Distinguish confirmed court/agency action from press characterization.`;
}

export function headlineWhy(topic: string): string {
  return `Touches ${topic}, from your recent research.`;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function briefEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|off|false|no)$/i.test((env["RESEARCH_BRIEF"] ?? "").trim());
}

// ---------------------------------------------------------------------------
// Two headline backends (Tavily, Firecrawl) feed one list per topic. The
// candidate shape is backend-neutral; the merge below is the policy point.
// ---------------------------------------------------------------------------

export type HeadlineBackend = "tavily" | "firecrawl";

export type HeadlineCandidate = {
  backend: HeadlineBackend;
  /** 1-based position in its backend's list. */
  rank: number;
  title: string;
  url: string;
  snippet: string;
  published?: string;
  imageUrl?: string;
};

/** Courts and agencies first, then the legal trade press. */
const PREFERRED_HOSTS = [
  "uscourts.gov",
  "jpml.uscourts.gov",
  "supremecourt.gov",
  "govinfo.gov",
  "federalregister.gov",
  "fda.gov",
  "justice.gov",
  "cpsc.gov",
  "nhtsa.gov",
  "law360.com",
  "law.com",
  "bloomberglaw.com",
  "reuters.com",
  "courthousenews.com",
  "legaldive.com",
];

/**
 * Plaintiff-intake marketing sites. They do carry real docket updates, so they
 * are not excluded, but they must never outrank a court order or the trade
 * press on a card the attorney reads as news. These dominated the live results
 * for every mass-tort query tested.
 */
const MARKETING_HOSTS = [
  "lawsuit-information-center.com",
  "torhoermanlaw.com",
  "sokolovelaw.com",
  "robertkinglawfirm.com",
  "drugwatch.com",
  "consumernotice.org",
  "jdsupra.com",
  "millerandzois.com",
  "legalexaminer.com",
];

const NEUTRAL_HOST_RANK = 50;
const MARKETING_HOST_RANK = 90;

function hostMatches(host: string, list: string[]): number {
  return list.findIndex((h) => host === h || host.endsWith(`.${h}`));
}

/** Sort key for a headline's source; lower sorts first. */
export function headlineHostRank(url: string): number {
  const host = hostOfUrl(url).toLowerCase();
  const preferred = hostMatches(host, PREFERRED_HOSTS);
  if (preferred !== -1) return preferred;
  return hostMatches(host, MARKETING_HOSTS) !== -1 ? MARKETING_HOST_RANK : NEUTRAL_HOST_RANK;
}

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|_hs|ref$|ref_src$)/i;

/** The same story from two backends usually differs only by tracking noise. */
export function canonicalHeadlineUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Age in days from an ISO/parsable date, or null when undated/unparsable. */
export function headlineAgeDays(published: string | undefined, now = Date.now()): number | null {
  if (!published) return null;
  const t = Date.parse(published);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/**
 * MERGE POLICY — the one decision here worth revisiting once real results are
 * visible. Given each backend's ranked list for a topic, return one ordered,
 * deduped list:
 *   1. drop items dated older than `maxAgeDays` (undated items are kept);
 *   2. dedupe by canonical URL, filling image / date / snippet gaps from the
 *      other backend's copy of the same story (Firecrawl news items usually
 *      carry an image; Tavily's snippets are usually the better summary);
 *   3. order by reciprocal rank across backends with a small k, so each
 *      backend's #1 outranks either backend's #2; a dated item gets a small
 *      bonus; ties keep the order the lists were given in.
 * Host preference (courts, agencies, Law360...) stays with the caller.
 */
export function mergeHeadlineCandidates(
  lists: HeadlineCandidate[][],
  opts?: { maxAgeDays?: number; now?: number },
): HeadlineCandidate[] {
  // 30 days, not 14: mass-tort docket news moves in weeks, and a two-week
  // window left topics with real recent developments showing no card at all.
  const maxAge = opts?.maxAgeDays ?? 30;
  const now = opts?.now ?? Date.now();
  const K = 3;
  const byKey = new Map<string, { item: HeadlineCandidate; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    for (const item of list) {
      const age = headlineAgeDays(item.published, now);
      if (age !== null && age > maxAge) continue;
      const key = canonicalHeadlineUrl(item.url);
      const score = 1 / (K + item.rank) + (age !== null ? 0.02 : 0);
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, { item: { ...item }, score, order: order++ });
        continue;
      }
      cur.score += score;
      cur.item = {
        ...cur.item,
        snippet: cur.item.snippet || item.snippet,
        ...(!cur.item.imageUrl && item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        ...(!cur.item.published && item.published ? { published: item.published } : {}),
      };
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.item);
}

/** Words too generic to prove a headline is about the topic. */
const GENERIC_TOPIC_TERMS = new Set([
  "litigation", "lawsuit", "lawsuits", "case", "cases", "claim", "claims", "court", "ruling",
  "rulings", "mdl", "mdls", "trial", "settlement", "docket", "rule", "update", "news",
]);

/** The terms a headline must touch to count as being about this topic. */
export function topicTerms(topic: string): string[] {
  return topic
    .split(/[\s/,]+/)
    .map((t) => t.replace(/[^A-Za-z0-9-]/g, "").toLowerCase())
    .filter((t) => t.length >= 3 && !GENERIC_TOPIC_TERMS.has(t));
}

/**
 * Is this headline actually about the topic? A news API asked for
 * "Depo-Provera MDL 3140 litigation court ruling" will happily return an
 * unrelated Law360 story, and an authority-weighted sort then puts that
 * FIRST — worse than showing no card. A headline qualifies when its title or
 * snippet contains at least one distinctive topic term (a hyphenated product
 * also matches when spelled with a space, as outlets often do).
 */
export function matchesTopic(topic: string, item: { title: string; snippet?: string }): boolean {
  const terms = topicTerms(topic);
  if (!terms.length) return true;
  const hay = `${item.title} ${item.snippet ?? ""}`.toLowerCase();
  const hit = (t: string) =>
    hay.includes(t) || (t.includes("-") && hay.includes(t.replace(/-/g, " ")));
  // A SHORT bare number is a weak signal: "702" (a rule cite) matched a Virginia
  // statute and an unrelated Ozempic page. A four-digit number is an MDL or JCCP
  // docket, which identifies the matter as well as its name does.
  const strong = terms.filter((t) => /[a-z]/.test(t) || /^\d{4,}$/.test(t));
  return (strong.length ? strong : terms).some(hit);
}

/** How many positions a source's tier may move a card. Authority breaks near
 *  ties; it never overrides topical relevance. */
const AUTHORITY_SHIFT = 2;

/**
 * Final card order for one topic: drop off-topic results, then keep the fused
 * relevance order with a small nudge for courts/trade press and against
 * intake-marketing pages.
 */
export function selectHeadlines<T extends { title: string; url: string; snippet?: string }>(
  topic: string,
  merged: T[],
  limit = 2,
): T[] {
  return merged
    .filter((item) => matchesTopic(topic, item))
    .map((item, index) => {
      const tier = headlineHostRank(item.url);
      const nudge =
        tier < NEUTRAL_HOST_RANK ? -AUTHORITY_SHIFT : tier > NEUTRAL_HOST_RANK ? AUTHORITY_SHIFT : 0;
      return { item, index, key: index + nudge };
    })
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}
