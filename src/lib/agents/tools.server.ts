import { searchWindow } from "./search-window";
// ============================================================================
// Research tools available to the Claude/Nemotron sub-agent (server-only).
//
// The web-search surface is ONE `web_search` tool over 16 category-scoped,
// authoritative domain allow-lists (federal/state case law, MDL/class-action,
// statutes, congressional, federal & state regulatory, SEC, FDA, agency
// enforcement, science, clinical trials, environmental/tox, company, judges/
// attorneys, legal news) + a general_web fallback — request-level domain
// filtering via the AgentCore gateway. Every result is a citable [S#] source.
// ============================================================================
import type { Artifact, Source } from "@/lib/chat-types";
import type { ToolDef } from "./anthropic.server";
import type { LitAgentKey } from "./prompts";
import {
  agentCoreSearch,
  agentCoreConfigured,
  type GatewayKey,
  type GatewayResult,
} from "./agentcore-search.server";
import { braveSearch, braveConfigured } from "./brave-search.server";
import { tavilySearch, tavilyConfigured } from "./tavily-search.server";
import {
  searchFilings,
  getFilingText,
  getCase as dbGetCaseApi,
  searchCases,
  getDocketSheet,
  getCalendar,
  graphAsk,
  docketbirdConfigured,
  type DbFiling,
  type DbCase,
} from "./docketbird.server";
import { memoTTL, toolCacheKey, TOOL_CACHE_TTL_MS } from "./run-state.server";
import {
  rankResults,
  allStale,
  wantsRecency,
  distinctiveTerms,
  fuseRankings,
  markSuperseded,
  normalizeUrl,
  type RankedResult,
} from "./web-rank";
import { semanticRerank } from "./web-rerank.server";

/** Assigns S1..Sn refs and dedupes sources across the whole run. */
export class SourceBook {
  private byKey = new Map<string, Source>();
  private order: Source[] = [];
  /** Verification-only shadow: the untrimmed text a source was built from,
   *  keyed by ref. Never sent to the model or the client; factCheck reads it so
   *  a specific the model saw on the page counts as verified even when it fell
   *  outside the trimmed `content` excerpt. */
  private fullText = new Map<string, string>();

  add(src: Omit<Source, "ref">, opts?: { fullText?: string }): Source {
    const key = sourceKey(src);
    const existing = this.byKey.get(key);
    if (existing) {
      // A re-read of the same source may carry more text than the first hit.
      if (opts?.fullText && opts.fullText.length > (this.fullText.get(existing.ref)?.length ?? 0)) {
        this.fullText.set(existing.ref, opts.fullText);
      }
      return existing;
    }
    const ref = `S${this.nextRef()}`;
    const full: Source = { ...src, ref };
    this.byKey.set(key, full);
    this.order.push(full);
    if (opts?.fullText) this.fullText.set(ref, opts.fullText);
    return full;
  }

  /** Untrimmed texts for verification (only sources that had one). */
  fullTexts(): string[] {
    return [...this.fullText.values()];
  }

  /** Host names behind a set of refs, most-cited first, deduped. */
  hostsFor(refs: string[], max = 3): string[] {
    const counts = new Map<string, number>();
    for (const ref of refs) {
      const src = this.order.find((s) => s.ref === ref);
      const host = hostOf(src?.source_url);
      if (!host) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([h]) => h);
  }

  /**
   * Re-registers sources carried over from earlier turns in the same session,
   * preserving their original [S#] refs so citations stay stable across a
   * conversation. New sources found this turn are numbered after them.
   */
  seed(sources: Source[]): void {
    for (const src of sources) {
      const key = sourceKey(src);
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, src);
      this.order.push(src);
    }
    this.order.sort((a, b) => refNum(a.ref) - refNum(b.ref));
  }

  all(): Source[] {
    return this.order;
  }

  /**
   * Copy every source of this book into `target`, deduped by the target's own
   * key (a source it already holds keeps its existing ref; new ones are
   * numbered after its last). The untrimmed verification text travels with
   * each source. Returns this book's ref -> the target's ref so the caller can
   * remap [S#] markers. Used when a speculative sweep that ran against a
   * scratch book is handed over to the run's real book.
   */
  transplantInto(target: SourceBook): Map<string, string> {
    const refMap = new Map<string, string>();
    if (target === this) {
      for (const src of this.order) refMap.set(src.ref, src.ref);
      return refMap;
    }
    for (const src of this.order) {
      const { ref, ...rest } = src;
      const full = this.fullText.get(ref);
      const added = target.add(rest, full ? { fullText: full } : undefined);
      refMap.set(ref, added.ref);
    }
    return refMap;
  }

  /** Lowest unused ref number, so seeded refs are never reissued. */
  private nextRef(): number {
    let n = this.order.length + 1;
    const used = new Set(this.order.map((x) => refNum(x.ref)));
    while (used.has(n)) n++;
    return n;
  }
}

/** Dedupe key. Registry excerpts key on citation + pinpoint (empty pinpoint
 *  included): their presigned PDF URLs are unique per call, so the same filing
 *  re-read on a later turn must not become a second source. Everything else
 *  keys on its URL, else its citation. */
function sourceKey(src: Omit<Source, "ref">): string {
  const key =
    src.authority === "registry"
      ? `${src.citation}|${src.section_path ?? ""}`
      : src.source_url || src.citation;
  return key.toLowerCase();
}

function refNum(ref: string): number {
  const n = Number(String(ref).replace(/^S/i, ""));
  return Number.isFinite(n) ? n : 0;
}

function hostOf(url?: string): string {
  if (!url || url.startsWith("/")) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export type ToolOutcome = { text: string; hits: number; refs: string[]; artifacts?: Artifact[] };

const clamp = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const trunc = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);

// --- Web search (ONE tool, 17 category-scoped domain sets) -----------------
// A single `web_search` tool. `categories` selects 1-4 curated authoritative
// domain allow-lists (agentcore-search DOMAIN_FILTERS) searched IN PARALLEL; the
// model picks by the job, adds published_after for recency, and passes 1-2 query
// reformulations. Replaces the old 7 category tools + search_authorities.

type Category = { key: GatewayKey; sourceType: string; blurb: string };

const CATEGORIES: Category[] = [
  {
    key: "federal_case_law",
    sourceType: "case_law",
    blurb:
      "federal opinions, dockets, appellate & Supreme Court decisions, free-law databases — precedent, holdings, posture",
  },
  {
    key: "state_case_law",
    sourceType: "case_law",
    blurb:
      "STATE courts & opinions incl. coordinated proceedings (CA JCCP, NJ MCL) — the state track federal PACER misses",
  },
  {
    key: "mdl_class_action",
    sourceType: "case_law",
    blurb:
      "JPML, MDL & class-action tracking, settlement administrators, class-action press — aggregation posture & settlements",
  },
  {
    key: "statutes_legislation",
    sourceType: "regulation",
    blurb:
      "federal & state statutes, codes, and bills — the text of a law and its legislative status",
  },
  {
    key: "congressional",
    sourceType: "regulation",
    blurb:
      "hearings, committee reports, GAO/CRS/CBO, oversight — congressional activity on an industry or defendant",
  },
  {
    key: "federal_regulations",
    sourceType: "regulation",
    blurb:
      "Federal Register, CFR/eCFR, regulations.gov, OIRA — the text and status of a federal rule",
  },
  {
    key: "state_ag_regulatory",
    sourceType: "regulation",
    blurb:
      "state AGs, state agencies (Prop 65/OEHHA, health & enviro depts), NCSL — state enforcement & regulation",
  },
  {
    key: "sec_securities",
    sourceType: "sec",
    blurb:
      "SEC/EDGAR, PCAOB, FINRA, Stanford SCAC — a public defendant's disclosures & securities suits",
  },
  {
    key: "fda_drug_device",
    sourceType: "enforcement",
    blurb:
      "FDA (recalls, warning letters, labels, MAUDE), EMA, DailyMed, pharma trade press — drug/device regulatory history",
  },
  {
    key: "agency_enforcement",
    sourceType: "enforcement",
    blurb:
      "FTC/CPSC/NHTSA/EPA/OSHA/CFPB/DOJ enforcement — recalls, consent decrees, violations, a defendant's compliance history",
  },
  {
    key: "scientific_medical",
    sourceType: "science",
    blurb:
      "peer-reviewed medicine & epidemiology (PubMed/PMC, top journals, Cochrane) — general & specific causation, study quality",
  },
  {
    key: "clinical_trials_safety",
    sourceType: "science",
    blurb:
      "ClinicalTrials.gov, EMA, FAERS/VAERS — trial records, sponsors, and drug-safety signals",
  },
  {
    key: "environmental_tox",
    sourceType: "technical",
    blurb:
      "EPA/ATSDR/IARC/NTP/NIEHS + engineering standards (ASTM/ANSI/UL/NIST) — toxicology, exposure, product/environmental science",
  },
  {
    key: "company_business",
    sourceType: "directory",
    blurb:
      "corporate background, SEC filings, business registries, financial press — a defendant's identity, structure & finances",
  },
  {
    key: "judges_attorneys",
    sourceType: "directory",
    blurb:
      "judge & attorney professional records (CourtListener, FJC, state bars, Ballotpedia) — background on the bench and counsel",
  },
  {
    key: "legal_news",
    sourceType: "news",
    blurb:
      "legal & industry trade press (Law360, Bloomberg Law, Reuters, Law.com, HarrisMartin) — current developments primaries haven't captured",
  },
  {
    key: "general_web",
    sourceType: "web",
    blurb:
      "OPEN web search (junk domains excluded) — ONLY when no category above fits: general current events, entity discovery, an obscure source",
  },
];

const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
const CATEGORY_KEYS: GatewayKey[] = CATEGORIES.map((c) => c.key);

const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description:
    "Authoritative web search over CURATED, category-scoped domain allow-lists (one gateway, request-level domain filtering). Pick 1-4 `categories` that best fit the job — they are searched IN PARALLEL, deduped, date-stamped, and ranked newest-and-most-relevant-first. RESULTS DEFAULT TO THE LAST 30 DAYS (deliberate, to keep answers current) — for anything OLDER (case law, statutes, a past ruling, historical filings, company background) you MUST pass `published_after` with an earlier date (e.g. '2020-01-01', or the specific year you need); omit it and you get ONLY the last 30 days. Pass 1-2 `queries` reformulations to run alongside the main query. CATEGORIES:\n" +
    CATEGORIES.map((c) => `- ${c.key}: ${c.blurb}`).join("\n") +
    "\nName specific entities in every query (party, drug/device, docket or rule number, doctrine, date). Prefer a scoped category over general_web. For dedicated STRUCTURED sources use the specialized tools instead (search_pubmed, sec_search, fda_search, federal_register_search, ecfr_search, clinicaltrials_search, db_*).",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A focused query of MAX 4 WORDS — the most distinctive terms only (a party/drug/device name, a docket or rule number, a doctrine, a holding). Never a sentence; every extra word ANDs the results smaller. Spread more entities across `queries` instead of lengthening this one.",
      },
      categories: {
        type: "array",
        items: { type: "string", enum: CATEGORY_KEYS },
        description:
          "1-4 category keys to search in parallel (see the list in the tool description). Use the smallest set that fits.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional 1-2 REFORMULATIONS (each MAX 4 WORDS) run in parallel with the main query — one alternate angle, one date-anchored for a live matter. Distinct angles, not near-duplicates.",
      },
      published_after: {
        type: "string",
        description:
          "Optional YYYY-MM-DD lower bound. DEFAULT when omitted = the LAST 30 DAYS (older results dropped at the source). Set an EARLIER date to WIDEN the window for older/historical material — case law, statutes, a past ruling, background (e.g. '2020-01-01' or the year you need). Applies to EVERY category in the call, so run historical and current searches separately.",
      },
      limit: { type: "number", description: "Results kept per category (default 6, cap 10)." },
    },
    required: ["query", "categories"],
  },
};

const CATEGORY_TOOL_DEFS: ToolDef[] = [WEB_SEARCH_TOOL];

// --- DocketBird tools (federal docket & filings) ---------------------------

const DOCKET_TOOL_DEFS: ToolDef[] = [
  {
    name: "db_find_case",
    description:
      "START HERE for anything about a specific case, MDL, or matter. DocketBird matches on the case CAPTION and the docket NUMBER — NOT party/company names, law-firm names, or descriptive phrases. Query the distinctive CAPTION words (e.g. 'social media adolescent addiction', 'insulin pricing') OR the docket number as YYYY-md-NNNN / YYYY-cv-NNNNN (e.g. '2022-md-03047'). Do NOT pass a party like 'Meta Platforms Inc.' or filler like 'litigation'/'lawsuit' — they are not in the caption and return ZERO; a bare 'MDL 3047' or '3047' will not disambiguate. Searches the ENTIRE federal+state index, not just followed matters. Returns each match's case_id for db_docket_sheet, db_search_filings, db_get_case, and db_calendar. If a name misses, retry with FEWER, more distinctive caption words. Do NOT guess a case_id.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A case name or a case number. Distinctive terms beat a full caption.",
        },
        court_id: {
          type: "string",
          description:
            "Optional court filter: slug ('njd','nysd'), abbreviation ('D.N.J.'), or full name.",
        },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "db_docket_sheet",
    description:
      "Get a case's DOCKET SHEET — the chronological list of docket entries (orders, motions, CMOs/PTOs, minute entries) — by case_id (from db_find_case). Use this for procedural posture, the LATEST activity (sort='recent'), and to locate a specific order (e.g. a CMO or scheduling order) before reading it. This is the right tool for 'what's the current posture / bellwether schedule / most recent order' — full-text filing search is NOT. Then read a specific entry with db_read_filing using its document_id. NOTE: on a very large or old MDL the full sheet can be slow — keep sort='recent' with a modest limit; if it is slow or times out, do NOT stop: fall back to db_search_filings scoped to this case_id with a targeted term ('case management order', 'scheduling order', 'bellwether').",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "DocketBird case id from db_find_case, e.g. 'jpml-0:2023-md-03080'.",
        },
        sort: {
          type: "string",
          enum: ["recent", "chronological"],
          description:
            "'recent' = newest entries first (best for latest activity); 'chronological' = docket order. Default 'recent'.",
        },
        limit: { type: "number", description: "Max entries to return (default 40, hard cap 80)." },
      },
      required: ["case_id"],
    },
  },
  {
    name: "db_search_filings",
    description:
      "Full-text search across federal court filings (PACER dockets, 283M+ documents). ALWAYS scope the search: pass court_id (a slug like 'txwd'/'cand'/'nysd', an abbreviation like 'S.D.N.Y.', or a full court name; comma-separate several), a case_id, and/or a date range — never an unscoped nationwide term. QUERY SYNTAX: words are ANDed by default; use \"exact phrase\" for a phrase, term* for word-stemming, a /s b (same sentence), a /3 b (within 3 words), a /p b (same paragraph), OR for alternatives, and -term to exclude (the word 'not' is unsupported). Set sort='recency' for the most recent filings. Returns matching filings with highlighted snippets, the case, court, filing date, and a permanent DocketBird link.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Distinctive terms or a "quoted phrase" — a party, doctrine, motion type, or docket/citation number. Words are ANDed; see the syntax in the description.',
        },
        court_id: {
          type: "string",
          description:
            "Scope to a court: slug ('txwd','cand','nysd'), abbreviation ('S.D.N.Y.'), or full name; comma-separate several.",
        },
        case_id: {
          type: "string",
          description: "Scope to one DocketBird case id, e.g. 'txwd-6:2021-cv-00672'.",
        },
        filed_after: { type: "string", description: "YYYY-MM-DD, inclusive." },
        filed_before: { type: "string", description: "YYYY-MM-DD, inclusive." },
        sort: {
          type: "string",
          enum: ["relevance", "recency"],
          description: "'relevance' (default) or 'recency' (most recently filed first).",
        },
        limit: { type: "number", description: "Max results (default 8, hard cap 15)." },
      },
      required: ["query"],
    },
  },
  {
    name: "db_read_filing",
    description:
      "Read the full extracted text of a specific filing by its document_id (from a db_search_filings result). Full text is available for the firm's own/followed matters; for other cases it returns access-limited and you should rely on the search snippets instead.",
    input_schema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "DocketBird document id, e.g. 'txwd-6:2021-cv-00672-00172-001'.",
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "db_get_case",
    description:
      "Get a case's metadata by DocketBird case id (e.g. 'txwd-6:2021-cv-00672'): title, court, filing info, and the complaint's document id. Use to confirm a matter's identity and court once you have its case_id from db_find_case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "DocketBird case id, e.g. 'txwd-6:2021-cv-00672'.",
        },
      },
      required: ["case_id"],
    },
  },
  {
    name: "db_calendar",
    description:
      "Get upcoming deadlines, hearings, and conferences for a case by case_id — the tool for scheduling/bellwether-timeline questions. Sourced from the firm's calendars, so it is richest for the firm's own/followed matters and may be empty for a case the firm does not track (say so rather than implying there are no deadlines).",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "DocketBird case id from db_find_case." },
      },
      required: ["case_id"],
    },
  },
  {
    name: "db_graph_ask",
    description:
      "Ask a natural-language question about litigation RELATIONSHIPS — which attorneys/firms appeared for a party, which judges a firm has appeared before, opposing-counsel patterns. Covers FEDERAL CIVIL cases only, ~30% coverage since mid-2025, and can take 10-25 seconds. Zero records means 'not in the graph', NOT that no such cases exist — say exactly that. Use only for relationship questions, not for docket posture or precedent.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "One clear relationship question, e.g. 'What judges has Quinn Emanuel appeared before in the District of New Jersey?'",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "matter_corpus_search",
    description:
      "Semantic search over the FIRM'S OWN INGESTED DOCKET CORPUS for one of its active MDL matters — the full text of the filings the firm has collected and indexed for that matter (a managed per-matter vector knowledge base). Use it to pull on-point passages BY MEANING from a matter's own record: what an order held, how a brief argued a point, an expert's opinion, a defense raised. This is NOT DocketBird — db_* hit the LIVE federal docket for ANY case; this searches only the firm's curated corpus for a KNOWN matter and returns the actual passage TEXT (not just docket lines). Prefer it over db_search_filings when the matter is one of the firm's own and you want the substance of what its filings SAY; it needs no case_id. Pass `matter` (the matter name or MDL — e.g. 'roundup', 'social media adolescent addiction', 'zantac', 'insulin pricing') and `query` (what to find). If the matter is not in the corpus, the tool returns the list of matters that ARE — pick from those.",
    input_schema: {
      type: "object",
      properties: {
        matter: {
          type: "string",
          description:
            "The matter/MDL to search, by name or number (e.g. 'roundup', 'social media addiction', 'MDL 2924'). Must be one of the firm's ingested matters; the tool lists them if it can't match.",
        },
        query: {
          type: "string",
          description:
            "What to find in that matter's filings — a holding, doctrine, expert, defense, fact, or ruling. A phrase or question; the corpus is searched by meaning, not keywords.",
        },
        limit: { type: "number", description: "Passages to return (default 8, cap 15)." },
      },
      required: ["matter", "query"],
    },
  },
];

export const AGENT_TOOLS: Record<LitAgentKey, ToolDef[]> = {
  legal_research: CATEGORY_TOOL_DEFS,
  docket_research: DOCKET_TOOL_DEFS,
};

// --- Execution -------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  book: SourceBook,
  opts?: { brave?: boolean; unrestrictedDates?: boolean },
): Promise<ToolOutcome> {
  if (name === "web_search") return webSearch(input, book, opts);

  if (name === "db_find_case") return dbFindCase(input, book);
  if (name === "db_docket_sheet") return dbDocketSheet(input, book);
  if (name === "db_search_filings") return dbSearchFilings(input, book);
  if (name === "db_read_filing") return dbReadFiling(input, book);
  if (name === "db_get_case") return dbGetCase(input, book);
  if (name === "db_calendar") return dbCalendar(input, book);
  if (name === "db_graph_ask") return dbGraphAsk(input, book);
  if (name === "matter_corpus_search") return matterCorpusSearch(input, book);
  return { text: `Unknown tool "${name}".`, hits: 0, refs: [] };
}

/** "August 2026" — appended to undated queries on recency-sensitive gateways. */
function currentMonthYear(now: Date = new Date()): string {
  return now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Run-scoped set of normalized URLs already handed to an agent, keyed by the
 *  run's SourceBook so dedupe spans every round and sub-agent of one run. */
const SEEN_URLS = new WeakMap<SourceBook, Set<string>>();
export function seenFor(book: SourceBook): Set<string> {
  let s = SEEN_URLS.get(book);
  if (!s) {
    s = new Set<string>();
    SEEN_URLS.set(book, s);
  }
  return s;
}

/** Fold the seen-URL set of `from` (a scratch book) into `into`'s, so once a
 *  speculative sweep is handed over the run's own searches skip its URLs. */
export function mergeSeen(from: SourceBook, into: SourceBook): void {
  if (from === into) return;
  const src = SEEN_URLS.get(from);
  if (!src?.size) return;
  const dst = seenFor(into);
  for (const k of src) dst.add(k);
}

const RECENCY_GATEWAYS = new Set<GatewayKey>([
  "legal_news",
  "mdl_class_action",
  "congressional",
  "federal_regulations",
  "state_ag_regulatory",
  "sec_securities",
  "fda_drug_device",
  "agency_enforcement",
  "company_business",
  "general_web",
]);

/** Over-fetch this many candidates per gateway variant, then keep the best few.
 *  Higher = more raw material for the local rerank to choose from (and more to
 *  survive the dedupe across the parallel variants). */
const CANDIDATE_POOL = 15;

async function categorySearch(
  cfg: Category,
  input: Record<string, unknown>,
  book: SourceBook,
  opts?: { brave?: boolean; unrestrictedDates?: boolean },
): Promise<ToolOutcome> {
  if (!agentCoreConfigured())
    return {
      text: "Authoritative search is not configured (SEARCH_AWS_ACCESS_KEY_ID / SEARCH_AWS_SECRET_ACCESS_KEY missing).",
      hits: 0,
      refs: [],
    };

  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };
  // Keep, not fetch: we pull a wide candidate pool from the gateway and let
  // the local rerank decide which few reach the prompt.
  const keep = clamp(input["limit"], 6, 10);
  const publishedAfter = str(input["published_after"]) || undefined;

  // Recency anchor: an undated query on a live matter ranks stale top hits
  // first. When the model gave no year/date, append the current month+year for
  // the recency-sensitive gateways (news, case law, enforcement) so the newest
  // orders and coverage surface. Static text (CFR, statutes, science) is left
  // alone — dating those queries only adds noise.
  const dateSensitive = !opts?.unrestrictedDates && RECENCY_GATEWAYS.has(cfg.key);
  const hasDate =
    /\b(19|20)\d{2}\b|\b(last|past|recent|latest|today|this (week|month|year))\b/i.test(query);
  const effectiveQuery = dateSensitive && !hasDate ? `${query} ${currentMonthYear()}` : query;
  const recency = dateSensitive || wantsRecency(query);
  const effectiveAfter = searchWindow({ unrestricted: opts?.unrestrictedDates, publishedAfter });

  // Query fan-out: the model's own reformulations plus a date-anchored variant
  // run CONCURRENTLY and merge into one candidate pool before ranking. More
  // angles per step is how a single round covers a question a lone generic
  // query would miss; URL/title dedupe in rankResults keeps the merge cheap.
  const variants: string[] = [effectiveQuery];
  const extras = Array.isArray(input["queries"]) ? (input["queries"] as unknown[]) : [];
  for (const e of extras) {
    const q = str(e);
    if (q.length >= 3 && q.toLowerCase() !== effectiveQuery.toLowerCase()) variants.push(q);
    if (variants.length >= 3) break;
  }
  if (
    dateSensitive &&
    hasDate &&
    !effectiveQuery.includes(currentMonthYear()) &&
    variants.length < 3
  ) {
    const anchored = `${query} ${currentMonthYear()}`;
    if (!variants.some((v) => v.toLowerCase() === anchored.toLowerCase())) variants.push(anchored);
  }

  // DETERMINISTIC RECALL GUARD — the reliable fix for a smaller model ANDing 8-9
  // terms into a 1-2 hit query (the zero-results retry below only fires on a TOTAL
  // zero, so 1-hit stuffed queries slip through). ALWAYS run TWO short, complementary
  // variants built from just the most distinctive terms, both IN PARALLEL with the
  // model's own queries in the same round: combo A keeps identifiers/years for a
  // precise anchor; combo B drops the bare year for a broader, date-relaxed angle.
  // Ranking still scores against the full original query, so this only broadens
  // recall, never loosens precision. Already-lean or duplicate combos are skipped.
  for (const combo of [
    distinctiveTerms(query, 4),
    distinctiveTerms(query, 4, { dropYears: true }),
  ]) {
    const leanQuery = combo.join(" ");
    if (combo.length >= 3 && !variants.some((v) => v.toLowerCase() === leanQuery.toLowerCase())) {
      variants.push(leanQuery);
    }
  }

  // Brave + Tavily are additional sources merged in parallel, but ONLY for the
  // research agent (opts.brave) and ONLY when their keys are set. The writer/Drafts
  // path calls executeTool without the flag, so `research` is false and the fan-out
  // stays byte-identical to before — no interference with that build.
  const research = !!opts?.brave;
  const brave = research && braveConfigured();
  const tavily = research && tavilyConfigured();
  // AgentCore + (optionally) Brave for one query, merged into one candidate pool.
  // Brave OFF => exactly agentCoreSearch(...) (unchanged). Brave ON => AgentCore
  // errors are swallowed so a gateway blip still yields Brave results (Brave itself
  // already returns [] on any error). Ranking + EXCLUDED_DOMAINS below filter both.
  const merged = (
    q: string,
    acOpts?: { publishedAfter?: string; openWeb?: boolean },
  ): Promise<GatewayResult[]> => {
    if (!brave) return agentCoreSearch(cfg.key, q, CANDIDATE_POOL, acOpts);
    return Promise.all([
      agentCoreSearch(cfg.key, q, CANDIDATE_POOL, acOpts).catch(() => [] as GatewayResult[]),
      braveSearch(
        q,
        CANDIDATE_POOL,
        acOpts?.publishedAfter ? { publishedAfter: acOpts.publishedAfter } : undefined,
      ),
    ]).then(([ac, br]) => [...ac, ...br]);
  };

  const fetchPool = (q: string) =>
    memoTTL(
      // Cache raw gateway hits (not the [S#]-tagged outcome): a repeat of the
      // same category+query within the window reuses one upstream call, and
      // SourceBook still assigns this run's own refs below. `brave` is in the key so
      // research (merged) and writer (AgentCore-only) never share a cache entry.
      toolCacheKey(`ac:${cfg.key}`, {
        query: q,
        limit: CANDIDATE_POOL,
        after: effectiveAfter ?? "",
        brave,
      }),
      TOOL_CACHE_TTL_MS,
      () => merged(q, effectiveAfter ? { publishedAfter: effectiveAfter } : undefined),
    );

  let results: GatewayResult[];
  if (research && (brave || tavily)) {
    // RESEARCH path — MINIMIZE AgentCore, PRIORITIZE the paid services. AgentCore
    // runs ONCE on the primary query (its in-account, allow-list-curated anchor);
    // Brave + Tavily — the fast, accurate paid sources — run across the primary + the
    // two deterministic lean combos for recall. Everything merges into one pool;
    // rankResults + EXCLUDED_DOMAINS + dedupe below pick the survivors. Each upstream
    // call is memoized for the run (Brave/Tavily keys are category-agnostic).
    const afterOpt = effectiveAfter ? { publishedAfter: effectiveAfter } : undefined;
    const leanQueries: string[] = [];
    for (const combo of [
      distinctiveTerms(query, 4),
      distinctiveTerms(query, 4, { dropYears: true }),
    ]) {
      const lq = combo.join(" ");
      if (
        combo.length >= 3 &&
        lq.toLowerCase() !== effectiveQuery.toLowerCase() &&
        !leanQueries.includes(lq)
      ) {
        leanQueries.push(lq);
      }
    }
    const paidQueries = [effectiveQuery, ...leanQueries];
    const jobs: Promise<GatewayResult[]>[] = [
      memoTTL(
        toolCacheKey(`ac:${cfg.key}`, {
          query: effectiveQuery,
          limit: CANDIDATE_POOL,
          after: effectiveAfter ?? "",
        }),
        TOOL_CACHE_TTL_MS,
        () => agentCoreSearch(cfg.key, effectiveQuery, CANDIDATE_POOL, afterOpt),
      ).catch(() => [] as GatewayResult[]),
    ];
    for (const q of paidQueries) {
      if (brave)
        jobs.push(
          memoTTL(
            toolCacheKey("brave", { query: q, limit: CANDIDATE_POOL, after: effectiveAfter ?? "" }),
            TOOL_CACHE_TTL_MS,
            () => braveSearch(q, CANDIDATE_POOL, afterOpt),
          ).catch(() => [] as GatewayResult[]),
        );
      if (tavily)
        jobs.push(
          memoTTL(
            toolCacheKey("tavily", {
              query: q,
              limit: CANDIDATE_POOL,
              after: effectiveAfter ?? "",
            }),
            TOOL_CACHE_TTL_MS,
            () => tavilySearch(q, CANDIDATE_POOL, afterOpt),
          ).catch(() => [] as GatewayResult[]),
        );
    }
    results = (await Promise.all(jobs)).flat();
  } else {
    // WRITER / default path — unchanged: AgentCore across all variants, memoized.
    try {
      const pools = await Promise.all(variants.map((q) => fetchPool(q)));
      results = pools.flat();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "search failed";
      return { text: `${cfg.key} failed: ${trunc(msg, 220)}`, hits: 0, refs: [] };
    }
  }

  // EMPTY-RESULT ESCALATION LADDER — the fix for the false zero. The category
  // whitelist + the 30-day window + an AND'd query multiply into frequent empties,
  // and the fan-out above never relaxes the whitelist or the date floor. So when it
  // comes back with nothing, RELAX ONE CONSTRAINT AT A TIME (leanest query first),
  // and stop at the first step that returns anything — never report a false zero
  // when the open web has the answer. The fresh-first 30-day default is preserved:
  // it is the FIRST pass; these steps only fire once it has already returned empty.
  if (!results.length) {
    const core = distinctiveTerms(query, 3);
    const leanQ = core.length >= 2 ? core.join(" ") : query;
    const ladder: Array<() => Promise<GatewayResult[]>> = [
      // (1) leanest query, SAME whitelist + 30-day window (a stuffed query was the miss)
      () => fetchPool(leanQ),
      // (2) SAME whitelist, NO date floor (the 30-day window was the miss)
      () => merged(leanQ),
      // (3) OPEN WEB (exclude-only) + NO date floor (the category whitelist was the miss)
      () => merged(leanQ, { openWeb: true }),
    ];
    for (const step of ladder) {
      try {
        results = await step();
      } catch {
        results = [];
      }
      if (results.length) break;
    }
  }

  if (!results.length) return { text: `No ${cfg.key} results for "${query}".`, hits: 0, refs: [] };

  const seen = seenFor(book);
  // Two-stage selection. (1) A WIDE lexical pass keeps up to 3x the target so
  // there is something to choose among — against a COPY of `seen` so the
  // candidates we end up cutting are not marked as already shown. (2) A
  // semantic order over the same candidates (Titan query/passage similarity,
  // hard-capped, fail-open) is fused with the lexical order by reciprocal rank,
  // and the top `keep` survive. Only the survivors are added to the real `seen`.
  const selectRanked = async (pool: GatewayResult[]): Promise<RankedResult<GatewayResult>[]> => {
    const wide = rankResults(pool, {
      query,
      keep: Math.min(keep * 3, 15),
      recency,
      sourceType: cfg.sourceType,
      seen: new Set(seen),
      // Tighter than the 0.25 default: a fan-out floods the pool with loosely
      // related hits (another MDL that merely shares "bellwether trial"), so
      // require stronger overlap with the matter's distinctive terms. Anchored
      // queries (party + MDL/JCCP number) clear this easily; topic-only noise does not.
      minRelevance: 0.32,
    });
    const keyOf = (r: RankedResult<GatewayResult>) =>
      normalizeUrl(r.result.url) || (r.result.title ?? "").toLowerCase();
    const byKey = new Map(wide.map((r) => [keyOf(r), r] as const));
    // Lexical order = the ranker's SCORE order (rankResults returns date order
    // for recency queries; that reordering is reapplied below to the survivors).
    const lexOrder = [...wide].sort((a, b) => b.score - a.score).map(keyOf);
    let chosen: RankedResult<GatewayResult>[];
    if (wide.length > keep) {
      // Candidates reach the semantic stage in LEXICAL-SCORE order (best first)
      // so its wall-clock cap trims the weakest matches, never the oldest ones
      // (`wide` is date-ordered for recency queries). Fuse only when the stage
      // scored enough of the pool to carry signal — a thin partial list would
      // just reorder by which candidates happened to embed in time — and score
      // the candidates it did not reach as if last on the semantic axis
      // (`missingRank`) instead of forfeiting that axis outright.
      const SEMANTIC_MIN_COVERAGE = 0.6;
      const semOrder = await semanticRerank(
        query,
        lexOrder.map((key) => {
          const r = byKey.get(key)!;
          return { key, text: `${r.result.title ?? ""}. ${r.evidence}` };
        }),
      );
      const covered = semOrder.filter((key) => byKey.has(key)).length;
      const useSemantic = covered / wide.length >= SEMANTIC_MIN_COVERAGE;
      const fused = fuseRankings(byKey, useSemantic ? [lexOrder, semOrder] : [lexOrder], {
        missingRank: "listLength",
      });
      chosen = fused.slice(0, keep).map((f) => f.item);
    } else {
      chosen = wide;
    }
    if (recency) {
      chosen.sort((a, b) => {
        if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (!a.date && b.date) return 1;
        if (a.date && !b.date) return -1;
        return b.score - a.score;
      });
    }
    for (const r of chosen) r.superseded = false;
    markSuperseded(chosen);
    for (const r of chosen) seen.add(keyOf(r));
    return chosen;
  };

  let ranked = await selectRanked(results);

  // One tightened retry when a recency question came back with nothing from the
  // last ~12 months — better than silently accepting stale top hits.
  if (recency && allStale(ranked)) {
    try {
      const retry = await fetchPool(`${query} ${new Date().getUTCFullYear()}`);
      const rankedRetry = await selectRanked(retry);
      if (rankedRetry.length && !allStale(rankedRetry)) ranked = rankedRetry;
      else if (!ranked.length) ranked = rankedRetry;
    } catch {
      /* keep what we have */
    }
  }

  if (!ranked.length)
    return {
      text: `No ${cfg.key} result added new on-point material for "${query}" (already-seen or off-topic hits filtered).`,
      hits: 0,
      refs: [],
    };

  const refs: string[] = [];
  const lines = ranked.map(({ result: r, evidence, date, superseded }) => {
    const src = book.add(
      {
        citation: r.title || r.url || `${cfg.key} result`,
        authority: "web",
        source_type: cfg.sourceType,
        source_url: r.url,
        effective_date: date ?? r.published,
        is_current: !superseded,
        // The client/reader gets a bounded excerpt; the prompt gets only the
        // query-focused evidence below; the untrimmed page text is kept on the
        // book's verification shadow so factCheck can match against it.
        content: trunc(r.text ?? "", 1500),
      },
      { fullText: r.text ?? "" },
    );
    refs.push(src.ref);
    const stamp = date ? `as of ${date}` : "date: unknown";
    const flag = superseded
      ? " [SUPERSEDED — a newer source on this subject is in this list; prefer it]"
      : "";
    return `[${src.ref}] ${r.title ?? ""} — ${r.url ?? ""} (${stamp})${flag}\n${evidence}`;
  });

  return { text: lines.join("\n\n"), hits: ranked.length, refs };
}

/** ONE model turn -> 1-4 category domain-sets searched in parallel. */
async function webSearch(
  input: Record<string, unknown>,
  book: SourceBook,
  opts?: { brave?: boolean; unrestrictedDates?: boolean },
): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "query must be at least 3 characters.", hits: 0, refs: [] };
  const raw = Array.isArray(input["categories"]) ? (input["categories"] as unknown[]) : [];
  const cfgs = raw
    .map((c) => CATEGORY_BY_KEY.get(str(c) as GatewayKey))
    .filter((c): c is Category => !!c)
    .slice(0, 4);
  if (!cfgs.length)
    return {
      text: `No valid categories. Pick 1-4 of: ${CATEGORY_KEYS.join(", ")}.`,
      hits: 0,
      refs: [],
    };

  const limit = clamp(input["limit"], 6, 10);
  const queries = Array.isArray(input["queries"]) ? input["queries"] : undefined;
  const publishedAfter = str(input["published_after"]) || undefined;
  const outcomes = await Promise.all(
    cfgs.map((cfg) =>
      categorySearch(cfg, { query, queries, limit, published_after: publishedAfter }, book, opts),
    ),
  );
  return {
    text: outcomes.map((o, i) => `### ${cfgs[i]!.key}\n${o.text}`).join("\n\n"),
    hits: outcomes.reduce((n, o) => n + o.hits, 0),
    refs: outcomes.flatMap((o) => o.refs),
  };
}

// --- DocketBird execution --------------------------------------------------

const stripEm = (s: string) => s.replace(/<\/?em>/gi, "");

async function dbSearchFilings(
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return {
      text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).",
      hits: 0,
      refs: [],
    };
  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };

  const searchArgs = {
    q: query,
    caseId: str(input["case_id"]) || undefined,
    courtId: str(input["court_id"]) || undefined,
    filedAfter: str(input["filed_after"]) || undefined,
    filedBefore: str(input["filed_before"]) || undefined,
    sort: str(input["sort"]) === "recency" ? ("recency" as const) : undefined,
    size: clamp(input["limit"], 4, 8),
  };
  let rows: DbFiling[];
  try {
    rows = await memoTTL(
      toolCacheKey("db_search", searchArgs as Record<string, unknown>),
      TOOL_CACHE_TTL_MS,
      () => searchFilings(searchArgs),
    );
  } catch (err) {
    return {
      text: `DocketBird search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!rows.length)
    return {
      text: `No filings match "${query}"${input["case_id"] || input["court_id"] ? " in that scope" : ""}.`,
      hits: 0,
      refs: [],
    };

  const refs: string[] = [];
  const lines = rows.map((r) => {
    const snip = (r.snippets ?? []).map(stripEm).join(" … ");
    const content = trunc(snip || r.document_title || "", 1400);
    const cite = `${r.case_title}${r.document_title ? ` — ${r.document_title}` : ""}${
      r.court_name ? ` (${r.court_name})` : ""
    }`;
    const src = book.add({
      citation: cite,
      authority: "registry",
      source_type: "filing",
      section_path: r.document_id,
      source_url: r.canonical_url,
      effective_date: r.date_filed ?? undefined,
      content,
    });
    refs.push(src.ref);
    return `[${src.ref}] document_id=${r.document_id} case_id=${r.case_id}\n${cite}${
      r.date_filed ? ` — filed ${r.date_filed}` : ""
    }\n${content}`;
  });
  return { text: lines.join("\n\n"), hits: rows.length, refs };
}

async function dbReadFiling(
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return {
      text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).",
      hits: 0,
      refs: [],
    };
  const id = str(input["document_id"]);
  if (!id) return { text: "document_id is required.", hits: 0, refs: [] };

  let doc: { id: string; title: string; text: string };
  try {
    doc = await memoTTL(toolCacheKey("db_read", { id }), TOOL_CACHE_TTL_MS, () =>
      getFilingText(id),
    );
  } catch (err) {
    return {
      text: `Could not read filing ${id}: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!doc.text.trim())
    return { text: `No extracted text available for document ${id}.`, hits: 0, refs: [] };

  const content = trunc(doc.text, 6000);
  const src = book.add(
    {
      citation: doc.title || `DocketBird document ${id}`,
      authority: "registry",
      source_type: "filing",
      section_path: id,
      content,
    },
    { fullText: doc.text },
  );
  return { text: `[${src.ref}] document_id=${id}\n${doc.title}\n${content}`, hits: 1, refs: [src.ref] };
}

async function dbGetCase(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return {
      text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).",
      hits: 0,
      refs: [],
    };
  const id = str(input["case_id"]);
  if (!id) return { text: "case_id is required.", hits: 0, refs: [] };

  let c: DbCase | null;
  try {
    c = await memoTTL<DbCase | null>(toolCacheKey("db_case", { id }), TOOL_CACHE_TTL_MS, () =>
      dbGetCaseApi(id),
    );
  } catch (err) {
    return {
      text: `Could not load case ${id}: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!c) return { text: `No case with id "${id}".`, hits: 0, refs: [] };

  const content = [
    `${c.title} — ${c.court_id}`,
    c.case_number ? `Case no. ${c.case_number}` : "",
    c.date_filed ? `Filed ${c.date_filed}` : "",
    c.complaint_document_id
      ? `Complaint document_id: ${c.complaint_document_id} (${c.complaint_status ?? "?"})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const src = book.add({
    citation: `${c.title} (${c.court_id})`,
    authority: "registry",
    source_type: "case",
    section_path: c.id,
    source_url: c.url,
    effective_date: c.date_filed ?? undefined,
    content,
  });
  return { text: `[${src.ref}] case_id=${c.id}\n${content}`, hits: 1, refs: [src.ref] };
}

const DB_NOT_CONFIGURED: ToolOutcome = {
  text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).",
  hits: 0,
  refs: [],
};
const dbCaseUrl = (id: string) =>
  `https://www.docketbird.com/cases?case_id=${encodeURIComponent(id)}`;

/** DocketBird's case search is strict-AND on the CAPTION (every token must be in
 *  the "In re ..." title), not party/firm names. Strip corporate suffixes, "In re",
 *  and filler so an over-specified query can retry as bare caption words. */
function cleanCaseQuery(q: string): string {
  return q
    .replace(/\bin re:?\b/gi, " ")
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|ltd|plc|lp|l\.p|n\.a|company|the)\b\.?/gi, " ")
    .replace(/\b(litigation|lawsuit|matter|et al)\b\.?/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ordered fallback queries for a case-search miss (strict-AND caption match):
 *  1) cleaned (corp suffix / "In re" / filler stripped); 2) everything AFTER the
 *  last corporate suffix, cleaned (drops a leading "Party Inc." → the subject);
 *  3) the cleaned query minus its first two (likely party) tokens. Live-verified:
 *  "Meta Platforms Inc. social media addiction litigation" -> "social media
 *  addiction" recovers the MDL, which the raw query returns zero for. */
function caseQueryCandidates(q: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length >= 3 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  const cleaned = cleanCaseQuery(q);
  push(cleaned);
  const afterSuffix = q.replace(
    /^.*\b(?:inc|llc|l\.l\.c|corp|corporation|co|ltd|plc|lp|n\.a|company)\b\.?/i,
    "",
  );
  if (afterSuffix.trim() && afterSuffix.trim().length < q.trim().length)
    push(cleanCaseQuery(afterSuffix));
  const toks = cleaned.split(" ");
  if (toks.length > 3) push(toks.slice(2).join(" "));
  return out.filter((c) => c.toLowerCase() !== q.toLowerCase());
}

async function dbFindCase(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };
  const courtId = str(input["court_id"]) || undefined;
  const size = clamp(input["limit"], 4, 8);

  let hits;
  try {
    hits = await memoTTL(
      toolCacheKey("db_find_case", { q: query, court: courtId ?? "", size }),
      TOOL_CACHE_TTL_MS,
      () => searchCases({ q: query, courtId, size }),
    );
  } catch (err) {
    return {
      text: `Case search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  // DocketBird case search is strict-AND on the caption, so any extra token (a
  // party name, "glyphosate", "litigation") that isn't in the caption zeroes the
  // result. On a miss, try a few progressively-cleaned caption candidates and
  // stop at the first that hits.
  if (!hits.length) {
    for (const cand of caseQueryCandidates(query)) {
      try {
        hits = await memoTTL(
          toolCacheKey("db_find_case", { q: cand, court: courtId ?? "", size }),
          TOOL_CACHE_TTL_MS,
          () => searchCases({ q: cand, courtId, size }),
        );
      } catch {
        /* try the next candidate */
      }
      if (hits.length) break;
    }
  }
  if (!hits.length)
    return {
      text: `No cases match "${query}"${courtId ? " in that court" : ""}. DocketBird matches the case CAPTION or the docket NUMBER — retry with the distinctive caption words (e.g. "social media adolescent addiction") or the number as YYYY-md-NNNN (e.g. "2022-md-03047"), NOT a party/company name.`,
      hits: 0,
      refs: [],
    };

  const refs: string[] = [];
  const lines = hits.map((c) => {
    const cite = `${c.title} (${c.court_name || c.court_id})${c.case_number ? `, No. ${c.case_number}` : ""}`;
    const content = [
      cite,
      c.date_filed ? `Filed ${c.date_filed}` : c.year_filed ? `Filed ${c.year_filed}` : "",
      c.complaint_document_id
        ? `Complaint document_id: ${c.complaint_document_id} (${c.complaint_status ?? "?"})`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const src = book.add({
      citation: cite,
      authority: "registry",
      source_type: "case",
      section_path: c.id,
      source_url: c.canonical_url || dbCaseUrl(c.id),
      effective_date: c.date_filed ?? undefined,
      content,
    });
    refs.push(src.ref);
    return `[${src.ref}] case_id=${c.id}\n${content}`;
  });
  const best = hits[0];
  // Inline the best match's recent docket entries so the agent can go straight
  // to reading filings — otherwise the "NEXT STEP: call db_docket_sheet"
  // instruction guarantees a whole extra model turn (~15s) per lookup.
  try {
    const sheet = await dbDocketSheet({ case_id: best.id, sort: "recent", limit: 8 }, book);
    if (sheet.hits > 0) {
      return {
        text: `${lines.join("\n\n")}\n\nRECENT DOCKET ENTRIES for the best match (case_id=${best.id}) — ALREADY LOADED, do NOT call db_docket_sheet for these:\n${sheet.text}\n\nNEXT STEP: db_read_filing the entry that matters, or call db_docket_sheet only if you need entries older than the ones above.`,
        hits: hits.length + sheet.hits,
        refs: [...refs, ...sheet.refs],
      };
    }
  } catch {
    /* fall through to the id-only response */
  }
  return {
    text: `${lines.join("\n\n")}\n\nNEXT STEP: you now have the case_id. Do NOT search for the case again. Call db_docket_sheet with the best case_id (e.g. "${best.id}", sort="recent") to read its posture and latest orders, then db_read_filing the entry that matters.`,
    hits: hits.length,
    refs,
  };
}

async function dbDocketSheet(
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const caseId = str(input["case_id"]);
  if (!caseId)
    return {
      text: "case_id is required — resolve the case with db_find_case first.",
      hits: 0,
      refs: [],
    };
  const sort = str(input["sort"]) === "chronological" ? "chronological" : "recent";
  const limit = clamp(input["limit"], 20, 40);

  let rows;
  try {
    rows = await memoTTL(toolCacheKey("db_docket", { case: caseId, sort }), TOOL_CACHE_TTL_MS, () =>
      getDocketSheet(caseId, sort as "chronological" | "recent"),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const slow = /abort|timeout|timed out/i.test(msg);
    return {
      text: slow
        ? `The docket sheet for ${caseId} is too large to pull whole (it timed out). Use db_search_filings scoped to case_id="${caseId}" with a targeted term (e.g. "case management order", "scheduling order", "bellwether") instead.`
        : `Could not load the docket for ${caseId}: ${trunc(msg, 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!rows.length) return { text: `No docket entries returned for ${caseId}.`, hits: 0, refs: [] };

  const shown = rows.slice(0, limit);
  const list = shown
    .map(
      (e) =>
        `- ${e.date_filed ?? "(no date)"} — ${e.title || "(untitled entry)"} [document_id=${e.id}]`,
    )
    .join("\n");
  const src = book.add({
    citation: `Docket sheet — ${caseId}`,
    authority: "registry",
    source_type: "docket",
    section_path: `${caseId}|docket`,
    source_url: dbCaseUrl(caseId),
    content: trunc(list, 4000),
  });
  return {
    text: `[${src.ref}] Docket sheet for ${caseId} (${sort}, showing ${shown.length} of ${rows.length}):\n${list}\n\nRead a specific entry with db_read_filing using its document_id.`,
    hits: shown.length,
    refs: [src.ref],
  };
}

async function dbCalendar(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const caseId = str(input["case_id"]);
  if (!caseId)
    return {
      text: "case_id is required — resolve the case with db_find_case first.",
      hits: 0,
      refs: [],
    };

  let entries;
  try {
    entries = await memoTTL(toolCacheKey("db_cal", { case: caseId }), TOOL_CACHE_TTL_MS, () =>
      getCalendar(caseId),
    );
  } catch (err) {
    return {
      text: `Could not load the calendar for ${caseId}: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!entries.length)
    return {
      text: `No calendar entries for ${caseId}. The firm may not be tracking this case — this is not evidence that the case has no deadlines.`,
      hits: 0,
      refs: [],
    };

  // Format the documented per-case shape (iso8601_datetime + title + document_id),
  // sorted soonest-first, so a "next hearing / trial" read is clean and chronological.
  const fmt = (e: Record<string, unknown>): { day: string; line: string } => {
    const dt = String(e["iso8601_datetime"] ?? e["date"] ?? "").trim();
    const day = dt.slice(0, 10);
    const time = dt.length > 10 ? dt.slice(11, 16) : "";
    const title = String(e["title"] ?? "").trim() || "(untitled entry)";
    const doc = e["document_id"] ? ` [document_id=${String(e["document_id"])}]` : "";
    return { day, line: `- ${day || "(no date)"}${time ? ` ${time}` : ""} — ${title}${doc}` };
  };
  const list = entries
    .map((e) => fmt(e as Record<string, unknown>))
    .sort((a, b) => (a.day && b.day ? a.day.localeCompare(b.day) : a.day ? -1 : 1))
    .slice(0, 40)
    .map((x) => x.line)
    .join("\n");
  const src = book.add({
    citation: `Calendar / deadlines — ${caseId}`,
    authority: "registry",
    source_type: "calendar",
    section_path: `${caseId}|calendar`,
    source_url: dbCaseUrl(caseId),
    content: trunc(list, 4000),
  });
  return {
    text: `[${src.ref}] Calendar entries for ${caseId}:\n${list}`,
    hits: entries.length,
    refs: [src.ref],
  };
}

async function dbGraphAsk(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const question = str(input["question"]);
  if (question.length < 5) return { text: "A question is required.", hits: 0, refs: [] };

  let r;
  try {
    r = await memoTTL(toolCacheKey("db_graph", { q: question }), TOOL_CACHE_TTL_MS, () =>
      graphAsk(question),
    );
  } catch (err) {
    return {
      text: `Litigation graph query failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (r.message) return { text: `${r.message} ${r.coverage_note}`.trim(), hits: 0, refs: [] };
  if (!r.num_records)
    return {
      text: `No records in the litigation graph for that question. That means it is NOT in the graph (federal civil only, ~30% coverage since mid-2025) — not that no such cases exist. ${r.coverage_note}`.trim(),
      hits: 0,
      refs: [],
    };

  const body = [
    r.interpretation ? `Interpretation: ${r.interpretation}` : "",
    `${r.num_records} record(s)${r.truncated ? " (truncated at 200)" : ""}:`,
    ...r.records.slice(0, 25).map((rec) => `- ${trunc(JSON.stringify(rec), 300)}`),
  ]
    .filter(Boolean)
    .join("\n");
  const src = book.add({
    citation: `DocketBird litigation graph: ${trunc(question, 80)}`,
    authority: "registry",
    source_type: "graph",
    section_path: `graph|${trunc(question, 60)}`,
    content: trunc(body, 4000),
  });
  return { text: `[${src.ref}] ${body}`, hits: r.num_records, refs: [src.ref] };
}

// --- Matter corpus (firm's own ingested docket KBs) ------------------------

async function matterCorpusSearch(
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "query must be at least 3 characters.", hits: 0, refs: [] };
  const { listMatterKbs, resolveMatterKb, retrieveMatterCorpus } = await import(
    "./matter-corpus.server"
  );
  const available = await listMatterKbs();
  if (!available.length)
    return { text: "No matter corpora are available for retrieval yet.", hits: 0, refs: [] };
  const matterQ = str(input["matter"]);
  const matter = await resolveMatterKb(matterQ);
  if (!matter) {
    const names = available.map((m) => `- ${m.title} (${m.matterId})`).join("\n");
    return {
      text: `Could not match "${matterQ}" to an ingested matter. Available matter corpora:\n${names}\n\nRetry with one of these.`,
      hits: 0,
      refs: [],
    };
  }
  const k = clamp(input["limit"], 8, 15);
  let passages;
  try {
    passages = await retrieveMatterCorpus(matter.kbId, query, k);
  } catch (err) {
    return {
      text: `Corpus retrieve failed for ${matter.title}: ${trunc(err instanceof Error ? err.message : "error", 200)}`,
      hits: 0,
      refs: [],
    };
  }
  if (!passages.length)
    return {
      text: `No passages in the ${matter.title} corpus matched "${query}".`,
      hits: 0,
      refs: [],
    };

  // date_filed rides the KB sidecar as a YYYYMMDD number (see docket-sync); the
  // other attributes are strings. Fall back cleanly when any are absent.
  const fmtFiled = (v: unknown): string => {
    const digits = (
      typeof v === "number" ? String(v) : typeof v === "string" ? v : ""
    ).replace(/\D/g, "");
    return digits.length === 8
      ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
      : "";
  };
  const refs: string[] = [];
  const lines = passages.map((p, i) => {
    const md = p.metadata ?? {};
    const title = str(md["title"]);
    const docketNo = str(md["docket_number"]);
    const docType = str(md["doc_type"]);
    const dateFiled = fmtFiled(md["date_filed"]);
    const cite =
      [matter.title, title || docType || undefined, docketNo ? `No. ${docketNo}` : undefined]
        .filter(Boolean)
        .join(" — ") || `${matter.title} filing`;
    const dbId = str(md["docketbird_document_id"]);
    const src = book.add(
      {
        citation: cite,
        authority: "registry",
        source_type: "filing",
        section_path: `${dbId || p.location || matter.kbId}#${i}`,
        ...(dateFiled ? { effective_date: dateFiled } : {}),
        content: trunc(p.text, 1500),
      },
      { fullText: p.text },
    );
    refs.push(src.ref);
    return `[${src.ref}] ${cite}${dateFiled ? ` — filed ${dateFiled}` : ""}\n${trunc(p.text, 1400)}`;
  });
  return {
    text: `Matter corpus — ${matter.title} (${passages.length} passages, most relevant first):\n\n${lines.join("\n\n")}`,
    hits: passages.length,
    refs,
  };
}
