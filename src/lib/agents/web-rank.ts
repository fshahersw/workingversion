// ============================================================================
// Web-result ranking + evidence extraction (pure, browser-safe, unit-tested).
//
// The gateways return long page text. Dumping 1,500 raw chars per result into
// every agent prompt was both slow (context) and inaccurate (the answer sat
// under a pile of boilerplate). Here we:
//   1. score each result by query relevance x recency x source tier,
//   2. keep only the top few, deduped by URL and capped per domain,
//   3. replace the raw dump with the query-matching sentence windows.
// Full text still goes to the SourceBook, so citations/reading are unchanged.
// ============================================================================

export type RankableResult = {
  title?: string;
  url?: string;
  text: string;
  published?: string;
};

export type RankedResult<T extends RankableResult = RankableResult> = {
  result: T;
  /** Extracted, query-focused evidence for the prompt. */
  evidence: string;
  /** ISO date (YYYY-MM-DD) when parseable, else null. */
  date: string | null;
  ageDays: number | null;
  score: number;
  /** Term-overlap relevance (0-1) before recency/tier weighting. */
  relevance: number;
  /** True when a newer kept result covers the same subject. */
  superseded: boolean;
};

/** Same tokenization as the pile BM25 index (inlined so this module stays
 *  dependency-free and runnable under the node test runner). */
export function tokenize(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const basic = lower.match(/[a-z0-9]+/g) ?? [];
  const docket = lower.match(/\d+:\d+-[a-z]+-\d+/g) ?? [];
  return [...basic, ...docket].filter((t) => t.length > 1 || /\d/.test(t));
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "by", "that", "this", "it", "as", "at",
  "from", "what", "which", "who", "how", "when", "any", "all", "about",
]);

/** Distinctive query terms used for both scoring and snippet anchoring. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(query)) {
    if (STOP.has(t) || t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Generic legal + temporal filler that ANDs poorly: present in nearly every
 *  litigation query, so keeping it in a short high-recall variant only shrinks
 *  the result set. Distinctive MATTER terms (party, drug, docket/MDL number,
 *  judge surname, doctrine) are what should survive. Month NAMES are here too —
 *  a bare year is a fine anchor, but "october" AND "november" both required kills
 *  recall. (The year token itself is numeric and scored up separately.) */
const GENERIC_TERMS = new Set([
  "trial", "trials", "case", "cases", "court", "courts", "order", "orders",
  "schedule", "scheduled", "scheduling", "setting", "date", "dates", "deadline", "deadlines",
  "litigation", "lawsuit", "lawsuits", "suit", "suits", "motion", "motions",
  "ruling", "rulings", "hearing", "hearings", "update", "updates", "upcoming",
  "news", "latest", "recent", "current", "ongoing", "pending", "status",
  "filing", "filings", "docket", "dockets", "plaintiff", "plaintiffs",
  "defendant", "defendants", "complaint", "complaints", "proceeding",
  "proceedings", "action", "actions", "judge", "judges", "attorney",
  "attorneys", "counsel", "january", "february", "march", "april", "june",
  "july", "august", "september", "october", "november", "december",
]);

/** Lowercased forms of tokens that appear Capitalized or ALL-CAPS in the raw
 *  query — a cheap proper-noun signal (Meta, YouTube, JCCP, Kuhl, MDL). */
function capitalizedForms(query: string): Set<string> {
  const out = new Set<string>();
  for (const m of query.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    if (/^[A-Z]/.test(m)) out.add(m.toLowerCase());
  }
  return out;
}

/** Deterministic keyword extraction: the most DISTINCTIVE terms of a query,
 *  ranked so identifiers (docket/MDL/JCCP numbers, years) and proper nouns
 *  (party, drug, judge, doctrine names) come first and generic legal/temporal
 *  filler ("trial", "schedule", "october", "status") is dropped. Used to build a
 *  short, high-recall search variant from an over-stuffed model query — the
 *  reliable fix for a smaller model's habit of ANDing 8-9 terms into 1-2 hits.
 *  Returns the ORIGINAL first-seen order among the survivors so the query stays
 *  readable. A query already at/under `max` distinctive terms is returned as-is.
 *  `dropYears` removes bare 19xx/20xx year tokens first (keeping docket/MDL/case
 *  numbers) to build a second, date-relaxed combo that is not pinned to one year. */
export function distinctiveTerms(
  query: string,
  max = 4,
  opts?: { dropYears?: boolean },
): string[] {
  let terms = queryTerms(query);
  if (opts?.dropYears) terms = terms.filter((t) => !/^(19|20)\d{2}$/.test(t));
  if (terms.length <= max) return terms;
  const caps = capitalizedForms(query);
  const score = (t: string): number => {
    let s = 0;
    if (/\d/.test(t)) s += 4; // years, docket / MDL / JCCP numbers
    if (caps.has(t)) s += 3; // proper nouns: Meta, YouTube, Kuhl, JCCP
    if (t.length >= 9) s += 2; // long specific terms (drug / doctrine names)
    else if (t.length >= 6) s += 1;
    if (GENERIC_TERMS.has(t)) s -= 5; // generic legal / temporal filler
    return s;
  };
  return terms
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i) // score desc, then original order
    .slice(0, max)
    .sort((a, b) => a.i - b.i) // restore readable order
    .map((x) => x.t);
}

/** Recency intent in the user's question / the agent's focus. */
export function wantsRecency(text: string): boolean {
  return /\b(latest|recent|recently|current|currently|now|today|this (week|month|year)|newest|up[- ]to[- ]date|next|upcoming|scheduled?|set for|trial date|hearing date|deadline|pending|still (pending|open)|ongoing|as of|202\d)\b/i.test(
    text || "",
  );
}

export function parseIsoDate(raw?: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() < 1900) return null;
  return d.toISOString().slice(0, 10);
}

export function ageInDays(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 86_400_000));
}

/** Normalized URL for cross-round dedupe (drops scheme, www, trailing slash, tracking params). */
export function normalizeUrl(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    const host = u.host.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function domainOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * Query-focused extract: the best contiguous sentence windows, capped at
 * maxChars. Returns "" when nothing in the text matches any query term — that
 * result is off-topic and should be dropped rather than padded into context.
 */
export function extractEvidence(text: string, terms: string[], maxChars = 450): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (!terms.length) return clean.slice(0, maxChars);

  const sentences = clean.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 20);
  if (!sentences.length) {
    const hit = terms.some((t) => clean.toLowerCase().includes(t));
    return hit ? clean.slice(0, maxChars) : "";
  }

  const scored = sentences.map((s, i) => {
    const toks = new Set(tokenize(s));
    let hits = 0;
    for (const t of terms) if (toks.has(t)) hits++;
    return { i, s, score: hits / Math.max(1, terms.length) };
  });

  const matches = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (!matches.length) return "";

  // Take best sentences in document order, up to the char budget; join with " … "
  // when they are not adjacent so the reader sees the gap.
  const picked = matches.slice(0, 4).sort((a, b) => a.i - b.i);
  const parts: string[] = [];
  let used = 0;
  let prev = -99;
  for (const p of picked) {
    const chunk = p.s.length > maxChars ? `${p.s.slice(0, maxChars)}…` : p.s;
    if (used + chunk.length > maxChars && parts.length) break;
    parts.push(prev >= 0 && p.i !== prev + 1 ? `… ${chunk}` : chunk);
    used += chunk.length + 2;
    prev = p.i;
  }
  return parts.join(" ").slice(0, maxChars + 40).trim();
}

/** Trade-press / aggregator domains rank below primary and official sources. */
const TIER3_HOST = /(law360|reuters|bloomberg|wsj|nytimes|forbes|medium|blogspot|wordpress|prnewswire|businesswire|yahoo|msn)\./i;
const TIER1_HOST = /(\.gov|\.uscourts\.gov|courtlistener|govinfo|federalregister|supremecourt|pacer)/i;

export function tierOf(url?: string, sourceType?: string): 1 | 2 | 3 {
  const u = url ?? "";
  if (TIER1_HOST.test(u)) return 1;
  if (sourceType === "case_law" || sourceType === "regulation") return 1;
  if (TIER3_HOST.test(u) || sourceType === "news") return 3;
  return 2;
}

// ---------------------------------------------------------------------------
// Junk-domain exclusion. Harder than tier scoring: these hosts are never
// citable for legal research. Two layers — sent to the provider as
// exclude_domains, and hard-dropped locally in case of syndication/redirects.
// ---------------------------------------------------------------------------

/** Highest-value entries, sent to the search provider as exclude_domains. */
export const EXCLUDED_DOMAINS: string[] = [
  "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
  "reddit.com", "quora.com", "pinterest.com", "linkedin.com", "threads.net",
  "youtube.com", "snapchat.com", "tumblr.com",
  "medium.com", "blogspot.com", "wordpress.com", "wikihow.com", "scribd.com",
  "coursehero.com", "studocu.com", "slideshare.net", "ezinearticles.com",
  "avvo.com", "lawyers.com", "superlawyers.com", "legalzoom.com",
  "msn.com", "news.yahoo.com", "dailymail.co.uk", "buzzfeed.com",
  "newsbreak.com", "ground.news", "patch.com",
];

/** Full local blocklist (superset of EXCLUDED_DOMAINS). */
const EXCLUDED_HOST =
  /(^|\.)(facebook|fb|instagram|twitter|x|tiktok|reddit|redd|quora|pinterest|linkedin|threads|youtube|youtu|snapchat|tumblr|vk|weibo|discord|telegram|whatsapp|mastodon|bsky|substack|medium|blogspot|wordpress|wikihow|scribd|coursehero|studocu|slideshare|ezinearticles|answers|ehow|examiner|msn|yahoo|dailymail|thesun|nypost|buzzfeed|newsbreak|patch|ground|taboola|outbrain|pinterest|amazon|ebay|etsy|alibaba|aliexpress|temu|walmart|avvo|lawyers|superlawyers|legalzoom|attorneyatlaw|injuryclaims|lawsuitinfocenter|topclassactions|consumersafety|drugwatch|drugdangers|classaction|lawsuit-information-center|legalexaminer|lawfirmnewswire|prweb)\.[a-z.]+$/i;

/** Directory/lead-gen subtrees on otherwise legitimate legal hosts. */
const EXCLUDED_PATH = /(justia|findlaw|nolo|hg|martindale)\.[a-z.]+\/(lawyer|lawyers|attorney|attorneys|find|directory)/i;

export function isExcludedHost(url?: string): boolean {
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return false;
  }
  if (EXCLUDED_HOST.test(host)) return true;
  return EXCLUDED_PATH.test(url);
}



/** Exponential recency decay: 1.0 today, ~0.5 at the half-life, floor 0.25. */
function recencyFactor(ageDays: number | null, halfLifeDays: number): number {
  if (ageDays === null) return 0.6; // undated: not preferred, not discarded
  return Math.max(0.25, Math.pow(0.5, ageDays / halfLifeDays));
}

/**
 * Hard age ceiling (~18 months) for date-sensitive searches. When at least
 * one dated result is inside the window, dated results older than it are
 * dropped outright — a stale top hit is worse than fewer hits. Undated
 * results are never dropped by this rule. When every dated result is stale
 * (an old settled matter), the cutoff is waived so something survives.
 */
export const RECENCY_CUTOFF_DAYS = 540;

/**
 * Minimum term-overlap relevance a result needs to enter the prompt at all.
 * A result that matches under a quarter of the distinctive query terms is
 * noise — dropping it protects the writer from conflicting off-topic pages.
 */
export const RELEVANCE_FLOOR = 0.25;

/**
 * Same-subject token set: distinctive title tokens (stopwords and pure
 * numbers removed). Two reports of the same order/ruling overlap heavily even
 * when their headlines differ in dates or extra clauses.
 */
function subjectTokens(title: string | undefined): Set<string> {
  return new Set(
    tokenize(title ?? "").filter((t) => !STOP.has(t) && t.length > 2 && !/^\d+$/.test(t)),
  );
}

/**
 * Flag older same-subject results so agents and the writer prefer the newest.
 * Two results are the same subject when the smaller token set is a subset of
 * the larger and they share at least three distinctive tokens.
 */
export function markSuperseded<T extends RankableResult>(ranked: RankedResult<T>[]): void {
  const groups: { toks: Set<string>; items: RankedResult<T>[] }[] = [];
  for (const r of ranked) {
    if (!r.date) continue;
    const toks = subjectTokens(r.result.title);
    if (toks.size < 3) continue;
    let placed = false;
    for (const g of groups) {
      const [small, large] = toks.size <= g.toks.size ? [toks, g.toks] : [g.toks, toks];
      if (small.size < 3) continue;
      let shared = 0;
      for (const t of small) if (large.has(t)) shared++;
      if (shared === small.size) {
        g.items.push(r);
        for (const t of toks) g.toks.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ toks: new Set(toks), items: [r] });
  }
  for (const g of groups) {
    if (g.items.length < 2) continue;
    g.items.sort((a, b) => (a.date! < b.date! ? 1 : -1));
    for (let i = 1; i < g.items.length; i++) g.items[i]!.superseded = true;
  }
}

export type RankOptions = {
  query: string;
  keep: number;
  recency: boolean;
  sourceType?: string;
  maxEvidenceChars?: number;
  perDomain?: number;
  /** Override the relevance floor (default RELEVANCE_FLOOR). 0 disables. */
  minRelevance?: number;
  /** Run-scoped set of normalized URLs already sent to an agent. Mutated. */
  seen?: Set<string>;
  now?: number;
};

export function rankResults<T extends RankableResult>(
  results: T[],
  opts: RankOptions,
): RankedResult<T>[] {
  const terms = queryTerms(opts.query);
  const maxChars = opts.maxEvidenceChars ?? 450;
  const perDomain = opts.perDomain ?? 2;
  const now = opts.now ?? Date.now();
  const halfLife = opts.recency ? 240 : 900;
  const minRelevance = opts.minRelevance ?? (terms.length >= 2 ? RELEVANCE_FLOOR : 0);

  // Recency cutoff applies only when at least one dated result is fresh —
  // otherwise this is an old matter and stale sources are the correct answer.
  const hasFresh =
    opts.recency &&
    results.some((r) => {
      const d = parseIsoDate(r.published);
      const a = ageInDays(d, now);
      return a !== null && a <= RECENCY_CUTOFF_DAYS;
    });

  const scored: RankedResult<T>[] = [];
  const localSeen = new Set<string>();

  for (const r of results) {
    if (isExcludedHost(r.url)) continue;
    const key = normalizeUrl(r.url) || (r.title ?? "").toLowerCase();
    if (!key) continue;
    if (localSeen.has(key)) continue;
    localSeen.add(key);
    if (opts.seen?.has(key)) continue;

    const date = parseIsoDate(r.published);
    const age = ageInDays(date, now);
    if (hasFresh && age !== null && age > RECENCY_CUTOFF_DAYS) continue;

    const evidence = extractEvidence(r.text, terms, maxChars);
    if (!evidence) continue;

    const titleToks = new Set(tokenize(`${r.title ?? ""} ${r.url ?? ""}`));
    const titleHits = terms.length
      ? terms.filter((t) => titleToks.has(t)).length / terms.length
      : 0;
    const evidenceToks = new Set(tokenize(evidence));
    const bodyHits = terms.length
      ? terms.filter((t) => evidenceToks.has(t)).length / terms.length
      : 0.5;

    const relevance = 0.65 * bodyHits + 0.35 * titleHits;
    if (relevance < minRelevance) continue;
    const tier = tierOf(r.url, opts.sourceType);
    const tierFactor = tier === 1 ? 1 : tier === 2 ? 0.9 : 0.78;
    const score = relevance * recencyFactor(age, halfLife) * tierFactor;

    scored.push({ result: r, evidence, date, ageDays: age, score, relevance, superseded: false });
  }

  scored.sort((a, b) => b.score - a.score);

  const out: RankedResult<T>[] = [];
  const domainCount = new Map<string, number>();
  for (const s of scored) {
    if (out.length >= opts.keep) break;
    const d = domainOf(s.result.url);
    if (d) {
      const n = domainCount.get(d) ?? 0;
      if (n >= perDomain) continue;
      domainCount.set(d, n + 1);
    }
    out.push(s);
    if (opts.seen) opts.seen.add(normalizeUrl(s.result.url) || (s.result.title ?? "").toLowerCase());
  }

  // Recency queries read newest-first; otherwise keep relevance order.
  if (opts.recency) {
    out.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (!a.date && b.date) return 1;
      if (a.date && !b.date) return -1;
      return b.score - a.score;
    });
  }
  markSuperseded(out);
  return out;
}

/** True when no kept result is newer than the given window. */
export function allStale(ranked: RankedResult[], maxAgeDays = 365): boolean {
  if (!ranked.length) return true;
  return ranked.every((r) => r.ageDays === null || r.ageDays > maxAgeDays);
}
