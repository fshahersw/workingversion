// Server-only litigation-intelligence collector.
//
// Tavily discovers candidate stories across curated query packs; Firecrawl
// enriches the top-ranked subset (image, description, author, canonical URL).
// The normalized result is written through the same `ingestFeed()` path the
// external ETL host uses, so storage, dedupe, run stats and retention behave
// identically no matter who produced the feed.
import type { IntelFeed, IntelItemInput } from "@/lib/intel-schema";
import { canonicalize } from "@/lib/intel-schema";

type Pack = {
  id: string;
  category: string;
  query: string;
  days: number;
  max: number;
};

const PACKS: Pack[] = [
  // --- mass tort / MDL core -------------------------------------------------
  { id: "mdl-mass-tort", category: "News", query: "MDL multidistrict litigation mass tort bellwether ruling", days: 10, max: 16 },
  { id: "jpml", category: "Order", query: "JPML judicial panel multidistrict litigation transfer order new MDL petition", days: 21, max: 12 },
  { id: "bellwether", category: "News", query: "bellwether trial date set mass tort MDL first trial", days: 21, max: 10 },
  { id: "product-liability", category: "News", query: "product liability lawsuit filed personal injury litigation update", days: 10, max: 12 },
  { id: "leadership", category: "News", query: "plaintiffs steering committee leadership appointment common benefit fund MDL order", days: 21, max: 10 },
  { id: "plaintiff-firms", category: "News", query: "plaintiffs law firm mass tort practice launch hire partner litigation group", days: 21, max: 8 },
  // --- courts, procedure, evidence -----------------------------------------
  { id: "courts-appeals", category: "Opinion", query: "federal appeals court ruling class action mass tort preemption", days: 14, max: 14 },
  { id: "daubert", category: "Opinion", query: "Daubert expert testimony exclusion ruling general causation litigation", days: 21, max: 10 },
  { id: "class-cert", category: "Opinion", query: "class certification granted denied Rule 23 consumer class action", days: 21, max: 10 },
  { id: "scotus", category: "Opinion", query: "Supreme Court certiorari argument ruling civil litigation liability preemption", days: 21, max: 10 },
  { id: "judiciary", category: "News", query: "federal judge confirmed appointed district court judicial nominee", days: 21, max: 6 },
  { id: "ai-courts", category: "Opinion", query: "judge sanctions lawyer AI fabricated citations hallucinated cases court order", days: 21, max: 12 },
  { id: "sanctions", category: "Order", query: "sanctions order attorney misconduct contempt litigation", days: 21, max: 10 },
  { id: "discovery", category: "Order", query: "discovery dispute spoliation adverse inference privilege ruling litigation", days: 21, max: 10 },
  // --- outcomes -------------------------------------------------------------
  { id: "verdicts", category: "Verdict", query: "jury verdict punitive damages award plaintiff trial mass tort product", days: 14, max: 14 },
  { id: "settlements", category: "Settlement", query: "mass tort settlement agreement fund claimants payout MDL", days: 21, max: 14 },
  { id: "settlement-admin", category: "Settlement", query: "settlement administrator claims deadline qualified settlement fund allocation", days: 30, max: 8 },
  { id: "bankruptcy", category: "News", query: "mass tort bankruptcy Texas two-step trust channeling injunction claimants", days: 30, max: 8 },
  { id: "litigation-finance", category: "News", query: "litigation funding disclosure rule third-party funder mass tort", days: 30, max: 8 },
  { id: "insurance", category: "News", query: "insurance coverage dispute liability policy duty to defend mass tort", days: 21, max: 8 },
  // --- agencies & enforcement ----------------------------------------------
  { id: "fda", category: "Regulatory", query: "FDA recall safety communication warning letter drug device", days: 10, max: 12 },
  { id: "epa", category: "Regulatory", query: "EPA rule chemical PFAS drinking water standard enforcement", days: 14, max: 10 },
  { id: "cpsc-ftc", category: "Enforcement", query: "CPSC FTC enforcement action recall consumer product deceptive practices", days: 14, max: 10 },
  { id: "doj", category: "Enforcement", query: "DOJ civil enforcement False Claims Act settlement corporate resolution", days: 14, max: 8 },
  { id: "state-ag", category: "Enforcement", query: "state attorney general lawsuit consumer protection settlement", days: 14, max: 10 },
  // --- substantive dockets --------------------------------------------------
  { id: "pfas", category: "News", query: "PFAS forever chemicals litigation water utility settlement claims", days: 21, max: 10 },
  { id: "pharma-device", category: "News", query: "drug injury lawsuit medical device litigation failure to warn", days: 14, max: 12 },
  { id: "talc-roundup", category: "News", query: "talc Roundup paraquat Camp Lejeune hair relaxer Ozempic litigation update", days: 14, max: 12 },
  { id: "securities-consumer", category: "News", query: "securities class action consumer data breach privacy class action filed", days: 14, max: 10 },
  { id: "environment", category: "News", query: "environmental contamination toxic exposure community lawsuit damages", days: 21, max: 8 },
  { id: "research", category: "Research", query: "study links exposure health risk litigation science epidemiology", days: 21, max: 12 },
  { id: "legal-industry", category: "News", query: "legal industry artificial intelligence courts e-discovery practice rules", days: 21, max: 8 },
  // --- practitioner commentary (discovery only, never scraped) --------------
  { id: "commentary", category: "Commentary", query: "attorney commentary mass tort MDL update linkedin post litigation takeaways", days: 14, max: 10 },
];


/** Domains we trust more; nudges signal score up. */
const AUTHORITY: Record<string, number> = {
  "reuters.com": 18, "law360.com": 16, "bloomberglaw.com": 17, "law.com": 15,
  "courtlistener.com": 20, "uscourts.gov": 22, "jpml.uscourts.gov": 24,
  "fda.gov": 22, "epa.gov": 20, "cpsc.gov": 20, "ftc.gov": 20, "justice.gov": 20,
  "reutersagency.com": 14, "apnews.com": 14, "wsj.com": 13, "nytimes.com": 12,
  "courthousenews.com": 14, "abovethelaw.com": 9, "legalnewsline.com": 10,
  "lawstreetmedia.com": 8, "jdsupra.com": 8, "natlawreview.com": 8,
  "insurancejournal.com": 7, "biopharmadive.com": 9, "linkedin.com": 3,
};

const PAYWALLED = new Set(["wsj.com", "nytimes.com", "bloomberglaw.com", "law360.com", "ft.com", "bloomberg.com"]);

const RELEVANT = [
  "mdl", "multidistrict", "mass tort", "class action", "bellwether", "plaintiff",
  "settlement", "recall", "lawsuit", "litigation", "jury", "verdict", "court",
  "judge", "complaint", "docket", "liability", "injury", "fda", "epa", "talc",
  "roundup", "paraquat", "camp lejeune", "hair relaxer", "ozempic", "cpap",
  "pfas", "sanctions", "daubert", "preemption", "appeal", "certification",
];

const MAX_SCRAPES = 110;
/** Max stories any single outlet can contribute to one run. */
const DOMAIN_CAP = 6;
/** Directory pages, firm marketing and award lists are not litigation signals. */
const JUNK =
  /(libguides|best lawyers|super lawyers|recognized by|named to|law firm rankings|attorney directory|webinar|cle credit|press release: | joins )/i;

const SCRAPE_CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;
/** Social/aggregator domains never render or scrape as litigation sources. */
const BLOCKED_DOMAINS =
  /(^|\.)(facebook|twitter|x|instagram|youtube|reddit|tiktok|pinterest|threads)\.com$/i;
/** LinkedIn is allowed as low-weight commentary: discovered, never scraped. */
const COMMENTARY_DOMAINS = /(^|\.)linkedin\.com$/i;


type TavilyHit = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
  favicon?: string;
  images?: unknown[];
};

/** Candidate picture for a story, before quality ranking. */
type ImageCandidate = { url: string; alt?: string; source: string; priority: number };

type Candidate = {
  packId: string;
  category: string;
  title: string;
  url: string;
  canonical: string;
  domain: string;
  summary: string | null;
  tavilyScore: number | null;
  publishedAt: string | null;
  score: number;
  tavilyImages: ImageCandidate[];
  favicon: string | null;
};

/** Publisher logos, avatars, sprites and ad pixels are not editorial imagery. */
const GENERIC_IMAGE = /logo|favicon|icon|avatar|gravatar|pixel|sprite|placeholder|social-share-default|metatag-image--default/i;
const AD_IMAGE = /doubleclick|adnxs|openx|googleads|tracking|analytics|1x1/i;

function imageQualityScore(img: ImageCandidate): number {
  const url = img.url;
  const hay = `${url} ${img.alt ?? ""}`.toLowerCase();
  let score = img.priority;
  if (/og:image|twitter:image|ogImage/i.test(img.source)) score += 40;
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) score += 12;
  if (/width=(?:8\d\d|9\d\d|1\d{3,})/i.test(url)) score += 8;
  if (GENERIC_IMAGE.test(hay)) score -= 35;
  if (AD_IMAGE.test(hay)) score -= 100;
  if (!/^https?:\/\//i.test(url)) score -= 100;
  return score;
}

function isGenericImage(img: ImageCandidate): boolean {
  return GENERIC_IMAGE.test(`${img.url} ${img.alt ?? ""}`);
}

function imageRelevance(image: ImageCandidate, title: string, summary: string | null): number {
  const words = new Set(
    `${title} ${summary ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 4),
  );
  const hay = (image.alt ?? "").toLowerCase();
  let matches = 0;
  for (const word of words) if (hay.includes(word)) matches++;
  return matches;
}

function markdownImages(markdown: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) out.push({ url: m[2] as string, alt: m[1] ?? "", source: "markdown", priority: 55 });
  return out.slice(0, 20);
}

function flatten(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(flatten);
  return typeof v === "string" && v.trim() ? [v.trim()] : [];
}

/** Pick the best available picture; label logo-ish winners as generic. */
function selectImage(
  tavilyImages: ImageCandidate[],
  meta: Record<string, unknown>,
  markdown: string,
  usedEditorial: Set<string>,
): { url: string; kind: "editorial" | "generic"; alt: string } | null {
  const candidates: ImageCandidate[] = [];
  const fields: Array<[string, number]> = [
    ["ogImage", 100], ["og:image", 100], ["og:image:url", 98],
    ["twitter:image", 94], ["image", 88],
  ];
  for (const [key, priority] of fields) {
    for (const url of flatten(meta[key])) candidates.push({ url, source: key, priority });
  }
  candidates.push(...tavilyImages);
  candidates.push(...markdownImages(markdown));

  const seen = new Set<string>();
  const ranked = candidates
    .filter((c) => {
      const key = canonicalize(c.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      c.url = key;
      return true;
    })
    .map((c) => ({ c, q: imageQualityScore(c) }))
    .filter((x) => x.q > -20)
    .sort((a, b) => b.q - a.q);

  const editorial = ranked.find((x) => !isGenericImage(x.c) && !usedEditorial.has(x.c.url));
  const best = editorial?.c ?? ranked.find((x) => isGenericImage(x.c))?.c;
  if (!best) return null;
  const kind = isGenericImage(best) ? "generic" : "editorial";
  if (kind === "editorial") usedEditorial.add(best.url);
  return { url: best.url, kind, alt: best.alt ?? "" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

/** Stable non-cryptographic URL fingerprint used only for collision-free row IDs. */
function stableId(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

async function withTimeout(url: string, init: RequestInit, ms = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function scoreOf(c: Omit<Candidate, "score">): number {
  const authority = AUTHORITY[c.domain] ?? 4;
  const hay = `${c.title} ${c.summary ?? ""}`.toLowerCase();
  const hits = RELEVANT.filter((k) => hay.includes(k)).length;
  const relevance = Math.min(24, hits * 5);
  let recency = 8;
  if (c.publishedAt) {
    const days = (Date.now() - new Date(c.publishedAt).getTime()) / 86_400_000;
    recency = days <= 1 ? 26 : days <= 3 ? 22 : days <= 7 ? 16 : days <= 14 ? 10 : 5;
  }
  const tav = Math.round((c.tavilyScore ?? 0) * 20);
  return Math.max(1, Math.min(100, authority + relevance + recency + tav));
}

async function tavilyPack(key: string, pack: Pack, errors: string[]): Promise<Candidate[]> {
  try {
    const res = await withTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: pack.query,
        topic: "news",
        search_depth: "advanced",
        days: pack.days,
        max_results: pack.max,
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
        include_favicon: true,
        language: "en",
        filter_by_language: true,
      }),
    });
    if (!res.ok) {
      errors.push(`${pack.id}: tavily ${res.status} ${(await res.text()).slice(0, 160)}`);
      return [];
    }
    const body = (await res.json()) as { results?: TavilyHit[]; images?: unknown[] };
    const sharedImages = (Array.isArray(body.images) ? body.images : [])
      .map((v): ImageCandidate | null => {
        if (typeof v === "string") return { url: v, source: "tavily", priority: 70 };
        const o = v as { url?: unknown; description?: unknown };
        return typeof o?.url === "string"
          ? { url: o.url, alt: typeof o.description === "string" ? o.description : "", source: "tavily", priority: 70 }
          : null;
      })
      .filter((v): v is ImageCandidate => v !== null && /^https?:\/\//i.test(v.url));
    const out: Candidate[] = [];
    for (const r of body.results ?? []) {
      const url = typeof r.url === "string" ? r.url : "";
      const title = (r.title ?? "").trim();
      if (!url || !title) continue;
      const domain = hostOf(url);
      if (!domain) continue;
      const published = r.published_date ? new Date(r.published_date) : null;
      const base = {
        packId: pack.id,
        category: pack.category,
        title,
        url,
        canonical: canonicalize(url),
        domain,
        summary: (r.content ?? "").trim().slice(0, 700) || null,
        tavilyScore: typeof r.score === "number" ? r.score : null,
        publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
        tavilyImages: [...(Array.isArray(r.images) ? r.images : []), ...sharedImages]
          .map((v): ImageCandidate | null => {
            if (typeof v === "string") return { url: v, source: "tavily", priority: 70 };
            const o = v as { url?: unknown; description?: unknown };
            return typeof o?.url === "string"
              ? { url: o.url, alt: typeof o.description === "string" ? o.description : "", source: "tavily", priority: 70 }
              : null;
          })
          .filter((v): v is ImageCandidate => v !== null && /^https?:\/\//i.test(v.url))
          .sort((a, b) => imageRelevance(b, title, r.content ?? null) - imageRelevance(a, title, r.content ?? null))
          .slice(0, 12),
        favicon: typeof r.favicon === "string" && r.favicon.trim() ? r.favicon.trim() : null,
      };
      out.push({ ...base, score: scoreOf(base) });
    }
    return out;
  } catch (e) {
    errors.push(`${pack.id}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

type Enrichment = {
  description?: string | null;
  metadata: Record<string, unknown>;
  markdown: string;
  author?: string | null;
  favicon?: string | null;
  canonical?: string | null;
};

async function firecrawl(key: string, url: string, errors: string[]): Promise<Enrichment | null> {
  try {
    const res = await withTimeout("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 15000,
        blockAds: true,
      }),
    });
    if (!res.ok) {
      errors.push(`${hostOf(url)}: firecrawl ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { data?: { metadata?: Record<string, unknown>; markdown?: string } };
    const md = (body.data?.metadata ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const markdown = typeof body.data?.markdown === "string" ? body.data.markdown : "";
    return {
      description: str(md["description"]) ?? str(md["ogDescription"]) ?? (markdown ? markdown.replace(/[#>*_`\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600) : null),
      metadata: md,
      markdown,
      author: str(md["author"]),
      favicon: str(md["favicon"]),
      canonical: str(md["sourceURL"]) ?? str(md["url"]),
    };
  } catch (e) {
    errors.push(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export type IntelRunResult = {
  ok: boolean;
  discovered: number;
  kept: number;
  scraped: number;
  editorialImages?: number;
  genericImages?: number;
  analyzed?: number;
  reviewed?: number;
  approved?: number;
  rejected?: number;
  pending?: number;
  imagesDropped?: number;
  docketAnalyzed?: number;
  analysisErrors?: string[];
  qaErrors?: string[];
  searchErrors: string[];
  scrapeErrors: string[];
  ingest?: Record<string, unknown>;
  message?: string;
  durationMs: number;
};

/** Run one full discovery + enrichment + ingest cycle. */
export async function runIntelCollection(): Promise<IntelRunResult> {
  const started = Date.now();
  const searchErrors: string[] = [];
  const scrapeErrors: string[] = [];

  const tavilyKey = process.env["TAVILY_API_KEY"];
  if (!tavilyKey) {
    return { ok: false, discovered: 0, kept: 0, scraped: 0, searchErrors, scrapeErrors, message: "TAVILY_API_KEY is not configured", durationMs: 0 };
  }
  const firecrawlKey = process.env["FIRECRAWL_API_KEY"] ?? null;

  const packResults = await Promise.all(PACKS.map((p) => tavilyPack(tavilyKey, p, searchErrors)));
  const discovered = packResults.flat();

  // De-duplicate by canonical URL, then by normalized title.
  const byUrl = new Map<string, Candidate>();
  for (const c of discovered) {
    const prev = byUrl.get(c.canonical);
    if (!prev || c.score > prev.score) byUrl.set(c.canonical, c);
  }
  const byTitle = new Map<string, Candidate>();
  for (const c of [...byUrl.values()].sort((a, b) => b.score - a.score)) {
    const k = normTitle(c.title);
    if (!byTitle.has(k)) byTitle.set(k, c);
  }
  // Drop directory/marketing pages, then cap how much any single outlet can own
  // so one wire service cannot flood the terminal.
  const perDomain = new Map<string, number>();
  const kept: Candidate[] = [];
  for (const c of [...byTitle.values()].sort((a, b) => b.score - a.score)) {
    if (JUNK.test(c.title) || BLOCKED_DOMAINS.test(c.domain)) continue;
    if (COMMENTARY_DOMAINS.test(c.domain)) {
      // Practitioner posts ride along as low-weight commentary only.
      c.category = "Commentary";
      c.score = Math.min(c.score, 45);
    }
    const n = perDomain.get(c.domain) ?? 0;
    if (n >= DOMAIN_CAP) continue;
    perDomain.set(c.domain, n + 1);
    kept.push(c);
    if (kept.length >= 300) break;
  }


  if (kept.length === 0) {
    return { ok: false, discovered: discovered.length, kept: 0, scraped: 0, searchErrors, scrapeErrors, message: "no results from discovery", durationMs: Date.now() - started };
  }

  const scrapable = kept.filter((c) => c.category !== "Commentary");
  const toScrape = firecrawlKey ? scrapable.slice(0, MAX_SCRAPES) : [];
  const enrichments = await mapLimit(toScrape, SCRAPE_CONCURRENCY, (c) =>
    firecrawl(firecrawlKey as string, c.url, scrapeErrors),
  );
  const enriched = new Map<string, Enrichment>();
  toScrape.forEach((c, i) => {
    const e = enrichments[i];
    if (e) enriched.set(c.canonical, e);
  });

  // ---- cached AI briefings ------------------------------------------------
  const analysisErrors: string[] = [];
  const { analyzeItems } = await import("@/lib/intel-analyze.server");
  const { analyses, errors: aiErrors } = await analyzeItems(
    kept.map((c) => {
      const e = enriched.get(c.canonical);
      return {
        key: c.canonical,
        title: c.title,
        source: c.domain,
        // Prefer the full extracted article body: richer input yields a far
        // better synthesis (quotes, numbers, posture) than a meta description.
        text: e?.markdown?.trim() || e?.description || c.summary,
      };
    }),
    { cap: 140, batchSize: 4, concurrency: 6 },
  );
  analysisErrors.push(...aiErrors);

  const fetchedAt = new Date().toISOString();
  let editorialImages = 0;
  let genericImages = 0;
  const usedEditorial = new Set<string>();
  const items: IntelItemInput[] = kept.map((c) => {
    const e = enriched.get(c.canonical);
    const picked = c.category === "Commentary" ? null : selectImage(c.tavilyImages, e?.metadata ?? {}, e?.markdown ?? "", usedEditorial);
    if (picked?.kind === "editorial") editorialImages++;
    else if (picked?.kind === "generic") genericImages++;
    return {
      id: `sw-${stableId(c.canonical)}`,
      category: c.category,
      title: c.title,
      url: c.url,
      canonicalUrl: c.canonical,
      domain: c.domain,
      sourceName: c.domain,
      publishedAt: c.publishedAt,
      fetchedAt,
      summary: e?.description ?? c.summary,
      favicon:
        e?.favicon ??
        c.favicon ??
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=64`,
      image: picked ? { url: picked.url, kind: picked.kind, alt: picked.alt || c.title } : null,
      paywall: PAYWALLED.has(c.domain) ? "metered" : null,
      rights: AUTHORITY[c.domain] && c.domain.endsWith(".gov") ? "public-domain" : "linked",
      renderMode: e ? "extracted" : "summary",
      signalScore: c.score,
      tavilyScore: c.tavilyScore,
      relatedTopics: RELEVANT.filter((k) => `${c.title} ${c.summary ?? ""}`.toLowerCase().includes(k)).slice(0, 6),
      queryPackIds: [c.packId],
      primarySources: [],
      analysisLead: analyses.get(c.canonical)?.lead ?? null,
      analysisBullets: analyses.get(c.canonical)?.bullets ?? [],
      analysisImpact: analyses.get(c.canonical)?.impact ?? null,
      metadata: { author: e?.author ?? null, description: e?.description ?? null },
    } satisfies IntelItemInput;
  });

  // ---- quality-assurance gate --------------------------------------------
  // Review the ranked stories before publishing: a text pass judges relevance,
  // grounding (briefing supported by the extract) and quality, then a vision
  // pass checks each surviving image. Items are ordered best-first, so the QA
  // cap covers everything the terminal actually surfaces. Fail-open: a model
  // outage keeps items visible rather than blanking the feed.
  const { reviewIntelItems, QA_TEXT_MODEL } = await import("@/lib/intel-qa.server");
  const {
    reviews,
    stats: reviewStats,
    errors: reviewErrors,
  } = await reviewIntelItems(
    items.map((it) => ({
      key: (it.canonicalUrl as string) || it.url,
      title: it.title,
      source: it.domain ?? it.sourceName ?? null,
      summary: it.summary ?? null,
      lead: it.analysisLead ?? null,
      bullets: it.analysisBullets ?? [],
      text:
        enriched.get(it.canonicalUrl as string)?.markdown ||
        enriched.get(it.canonicalUrl as string)?.description ||
        it.summary ||
        null,
      category: it.category,
      imageUrl: it.image?.url ?? null,
    })),
  );
  for (const it of items) {
    const verdict = reviews.get((it.canonicalUrl as string) || it.url);
    if (!verdict) continue;
    it.reviewStatus = verdict.status;
    it.reviewScore = verdict.score;
    it.reviewReasons = verdict.reasons;
    it.imageReview = verdict.imageReview;
    it.reviewerModel = QA_TEXT_MODEL;
    // A thumbnail that failed the vision gate is dropped; the card falls back to
    // a favicon while the story itself remains.
    if (verdict.imageReview === "dropped") it.image = null;
  }

  const feed: IntelFeed = {
    generatedAt: fetchedAt,
    schemaVersion: "intel-v1",
    stats: {
      discovered: discovered.length,
      kept: items.length,
      scraped: enriched.size,
      editorialImages,
      genericImages,
      analyzed: analyses.size,
      reviewed: reviewStats.reviewed,
      approved: reviewStats.approved,
      rejected: reviewStats.rejected,
      pending: reviewStats.pending,
      imagesChecked: reviewStats.imagesChecked,
      imagesDropped: reviewStats.imagesDropped,
      qaErrors: reviewStats.qaErrors,
    },
    errors: { search: searchErrors, scrape: scrapeErrors, analysis: analysisErrors, qa: reviewErrors },
    retainDays: 90,
    items,
  };

  const { ingestFeed, refreshDocketAnalysis } = await import("@/lib/intel.server");
  const ingest = await ingestFeed(feed);
  const docket = await refreshDocketAnalysis(60);
  analysisErrors.push(...docket.errors);

  return {
    ok: true,
    discovered: discovered.length,
    kept: items.length,
    scraped: enriched.size,
    editorialImages,
    genericImages,
    analyzed: analyses.size,
    reviewed: reviewStats.reviewed,
    approved: reviewStats.approved,
    rejected: reviewStats.rejected,
    pending: reviewStats.pending,
    imagesDropped: reviewStats.imagesDropped,
    docketAnalyzed: docket.analyzed,
    searchErrors,
    scrapeErrors,
    analysisErrors,
    qaErrors: reviewErrors,
    ingest,
    durationMs: Date.now() - started,
  };
}
