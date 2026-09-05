// ============================================================================
// Research tools available to the Claude/Nemotron sub-agent (server-only).
//
// The sub-agent's tools are seven category-scoped AWS Bedrock AgentCore search
// gateways (case law, regulatory text, enforcement history, science, technical/
// environmental, judicial-parties, legal news) — allow-listed authoritative web
// search, one MCP tool each. They replaced the Supabase corpus tools and the
// single Tavily web_search. Every result is registered as a citable [S#] source.
// ============================================================================
import type { Artifact, Source } from "@/lib/chat-types";
import type { ToolDef } from "./anthropic.server";
import type { LitAgentKey } from "./prompts";
import {
  agentCoreSearch,
  agentCoreConfigured,
  type GatewayKey,
} from "./agentcore-search.server";
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
import { rankResults, allStale, wantsRecency } from "./web-rank";


/** Assigns S1..Sn refs and dedupes sources across the whole run. */
export class SourceBook {
  private byKey = new Map<string, Source>();
  private order: Source[] = [];

  add(src: Omit<Source, "ref">): Source {
    // Registry excerpts dedupe on citation+pinpoint (presigned PDF URLs are
    // unique per call, so they cannot be the dedupe key).
    const key = (
      src.authority === "registry" && src.section_path
        ? `${src.citation}|${src.section_path}`
        : src.source_url || src.citation
    ).toLowerCase();
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const ref = `S${this.nextRef()}`;
    const full: Source = { ...src, ref };
    this.byKey.set(key, full);
    this.order.push(full);
    return full;
  }

  /**
   * Re-registers sources carried over from earlier turns in the same session,
   * preserving their original [S#] refs so citations stay stable across a
   * conversation. New sources found this turn are numbered after them.
   */
  seed(sources: Source[]): void {
    for (const src of sources) {
      const key = (
        src.authority === "registry" && src.section_path
          ? `${src.citation}|${src.section_path}`
          : src.source_url || src.citation
      ).toLowerCase();
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, src);
      this.order.push(src);
    }
    this.order.sort((a, b) => refNum(a.ref) - refNum(b.ref));
  }

  all(): Source[] {
    return this.order;
  }

  /** Lowest unused ref number, so seeded refs are never reissued. */
  private nextRef(): number {
    let n = this.order.length + 1;
    const used = new Set(this.order.map((x) => refNum(x.ref)));
    while (used.has(n)) n++;
    return n;
  }
}

function refNum(ref: string): number {
  const n = Number(String(ref).replace(/^S/i, ""));
  return Number.isFinite(n) ? n : 0;
}

export type ToolOutcome = { text: string; hits: number; refs: string[]; artifacts?: Artifact[] };

const clamp = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const trunc = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);

// --- Category tools --------------------------------------------------------
// One tool per gateway. Descriptions are what the sub-agent uses to pick the
// right source, so the regulatory-text vs. enforcement-history split is spelled
// out explicitly — they are easy to conflate from the name alone.

type CategoryTool = {
  name: string;
  gateway: GatewayKey;
  sourceType: string;
  description: string;
};

const CATEGORY_TOOLS: CategoryTool[] = [
  {
    name: "search_case_law",
    gateway: "case_law",
    sourceType: "case_law",
    description:
      "Search official case law, court dockets, and appellate opinions (Supreme Court, circuit courts, PACER-sourced dockets). Use for precedent, holdings, procedural history, and jurisdiction or court-procedure questions.",
  },
  {
    name: "search_regulatory_text",
    gateway: "regulatory_statutory",
    sourceType: "regulation",
    description:
      "Search primary regulatory and statutory TEXT: the CFR, Federal Register, and agency rules. Use for the language of a regulation or statute — NOT its enforcement history.",
  },
  {
    name: "search_enforcement_history",
    gateway: "regulatory_enforcement",
    sourceType: "enforcement",
    description:
      "Search regulatory ENFORCEMENT history: recalls, FDA and agency warning letters, consent decrees, and violations. Use for a defendant's compliance, notice, or prior-violation history — distinct from regulatory text.",
  },
  {
    name: "search_scientific_literature",
    gateway: "scientific_research",
    sourceType: "science",
    description:
      "Search peer-reviewed medical and epidemiological literature. Use for general and specific causation, study design and quality, clinical evidence, and an expert witness's publication record.",
  },
  {
    name: "search_technical_environmental",
    gateway: "technical_environmental",
    sourceType: "technical",
    description:
      "Search engineering standards bodies and environmental-science sources. Use for product-defect, materials, exposure-modeling, and environmental-contamination questions.",
  },
  {
    name: "search_judicial_parties",
    gateway: "judicial_parties",
    sourceType: "directory",
    description:
      "Search official judicial and attorney-registration records for judge, attorney, and firm background. Professional records only — never request or surface personal or home information.",
  },
  {
    name: "search_legal_news",
    gateway: "legal_news",
    sourceType: "news",
    description:
      "Search legal trade press for current litigation news and developments. Use for recent events the primary sources have not yet captured.",
  },
];

const CATEGORY_BY_NAME = new Map(CATEGORY_TOOLS.map((t) => [t.name, t]));

const toToolDef = (t: CategoryTool): ToolDef => ({
  name: t.name,
  description: t.description,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A focused query of a few distinctive terms — a statute or rule number, a party/drug/device name, a doctrine, or a holding. Keep it tight.",
      },
      limit: { type: "number", description: "Max results (default 5, hard cap 10)." },
    },
    required: ["query"],
  },
});

const MULTI_SEARCH_TOOL: ToolDef = {
  name: "search_authorities",
  description:
    "PREFERRED FIRST CALL. Runs the SAME query against 2-3 category gateways CONCURRENTLY in one step, instead of one call per category. Results are deduped, date-stamped, and ranked newest-and-most-relevant-first. Use the single-category tools only for a targeted follow-up.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A focused query of a few distinctive terms — a statute or rule number, a party/drug/device name, a doctrine, or a holding. Name the specific entities (parties, docket/rule numbers, agencies), never a generic one-liner.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "1-2 REFORMULATIONS of the main query run in parallel with it (one alternate angle, one anchored to the current month+year for anything live). Distinct angles, not near-duplicates.",
      },
      categories: {
        type: "array",
        items: { type: "string", enum: CATEGORY_TOOLS.map((t) => t.name) },
        description: "2-3 category tool names to search in parallel.",
      },
      limit: { type: "number", description: "Results kept per category (default 4, cap 6)." },
    },
    required: ["query", "categories"],
  },
};

const CATEGORY_TOOL_DEFS: ToolDef[] = [MULTI_SEARCH_TOOL, ...CATEGORY_TOOLS.map(toToolDef)];




// --- DocketBird tools (federal docket & filings) ---------------------------

const DOCKET_TOOL_DEFS: ToolDef[] = [
  {
    name: "db_find_case",
    description:
      "START HERE for anything about a specific case, MDL, or matter. Searches the ENTIRE federal+state case index by case NAME (e.g. 'In re Insulin Pricing Litigation') or case NUMBER (e.g. '0:2023-md-03080' or '22-cv-4775'), not just followed matters. Returns each match's DocketBird case_id — which you then pass to db_docket_sheet, db_search_filings, db_get_case, and db_calendar. Do NOT guess a case_id and do NOT pass an MDL number to db_get_case; resolve it here first.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A case name or a case number. Distinctive terms beat a full caption." },
        court_id: { type: "string", description: "Optional court filter: slug ('njd','nysd'), abbreviation ('D.N.J.'), or full name." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "db_docket_sheet",
    description:
      "Get a case's DOCKET SHEET — the chronological list of docket entries (orders, motions, CMOs/PTOs, minute entries) — by case_id (from db_find_case). Use this for procedural posture, the LATEST activity (sort='recent'), and to locate a specific order (e.g. a CMO or scheduling order) before reading it. This is the right tool for 'what's the current posture / bellwether schedule / most recent order' — full-text filing search is NOT. Then read a specific entry with db_read_filing using its document_id.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "DocketBird case id from db_find_case, e.g. 'jpml-0:2023-md-03080'." },
        sort: { type: "string", enum: ["recent", "chronological"], description: "'recent' = newest entries first (best for latest activity); 'chronological' = docket order. Default 'recent'." },
        limit: { type: "number", description: "Max entries to return (default 40, hard cap 80)." },
      },
      required: ["case_id"],
    },
  },
  {
    name: "db_search_filings",
    description:
      "Full-text search across federal court filings (PACER dockets, 283M+ documents). ALWAYS scope the search: pass court_id (a slug like 'txwd'/'cand'/'nysd', an abbreviation like 'S.D.N.Y.', or a full court name), a case_id, and/or a date range — never an unscoped nationwide term. Returns matching filings with highlighted snippets, the case, court, filing date, and a permanent DocketBird link.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few distinctive terms — a party, doctrine, motion type, or docket/citation number. Words are ANDed." },
        court_id: { type: "string", description: "Scope to a court: slug ('txwd','cand','nysd'), abbreviation, or full name." },
        case_id: { type: "string", description: "Scope to one DocketBird case id, e.g. 'txwd-6:2021-cv-00672'." },
        filed_after: { type: "string", description: "YYYY-MM-DD, inclusive." },
        filed_before: { type: "string", description: "YYYY-MM-DD, inclusive." },
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
      properties: { document_id: { type: "string", description: "DocketBird document id, e.g. 'txwd-6:2021-cv-00672-00172-001'." } },
      required: ["document_id"],
    },
  },
  {
    name: "db_get_case",
    description:
      "Get a case's metadata by DocketBird case id (e.g. 'txwd-6:2021-cv-00672'): title, court, filing info, and the complaint's document id. Use to confirm a matter's identity and court once you have its case_id from db_find_case.",
    input_schema: {
      type: "object",
      properties: { case_id: { type: "string", description: "DocketBird case id, e.g. 'txwd-6:2021-cv-00672'." } },
      required: ["case_id"],
    },
  },
  {
    name: "db_calendar",
    description:
      "Get upcoming deadlines, hearings, and conferences for a case by case_id — the tool for scheduling/bellwether-timeline questions. Sourced from the firm's calendars, so it is richest for the firm's own/followed matters and may be empty for a case the firm does not track (say so rather than implying there are no deadlines).",
    input_schema: {
      type: "object",
      properties: { case_id: { type: "string", description: "DocketBird case id from db_find_case." } },
      required: ["case_id"],
    },
  },
  {
    name: "db_graph_ask",
    description:
      "Ask a natural-language question about litigation RELATIONSHIPS — which attorneys/firms appeared for a party, which judges a firm has appeared before, opposing-counsel patterns. Covers FEDERAL CIVIL cases only, ~30% coverage since mid-2025, and can take 10-25 seconds. Zero records means 'not in the graph', NOT that no such cases exist — say exactly that. Use only for relationship questions, not for docket posture or precedent.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "One clear relationship question, e.g. 'What judges has Quinn Emanuel appeared before in the District of New Jersey?'" } },
      required: ["question"],
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
): Promise<ToolOutcome> {
  if (name === MULTI_SEARCH_TOOL.name) return multiCategorySearch(input, book);
  const cfg = CATEGORY_BY_NAME.get(name);
  if (cfg) return categorySearch(cfg, input, book);

  if (name === "db_find_case") return dbFindCase(input, book);
  if (name === "db_docket_sheet") return dbDocketSheet(input, book);
  if (name === "db_search_filings") return dbSearchFilings(input, book);
  if (name === "db_read_filing") return dbReadFiling(input, book);
  if (name === "db_get_case") return dbGetCase(input, book);
  if (name === "db_calendar") return dbCalendar(input, book);
  if (name === "db_graph_ask") return dbGraphAsk(input, book);
  return { text: `Unknown tool "${name}".`, hits: 0, refs: [] };
}

/** "August 2026" — appended to undated queries on recency-sensitive gateways. */
function currentMonthYear(now: Date = new Date()): string {
  return now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Run-scoped set of normalized URLs already handed to an agent, keyed by the
 *  run's SourceBook so dedupe spans every round and sub-agent of one run. */
const SEEN_URLS = new WeakMap<SourceBook, Set<string>>();
function seenFor(book: SourceBook): Set<string> {
  let s = SEEN_URLS.get(book);
  if (!s) {
    s = new Set<string>();
    SEEN_URLS.set(book, s);
  }
  return s;
}

const RECENCY_GATEWAYS = new Set<GatewayKey>([
  "legal_news",
  "case_law",
  "regulatory_enforcement",
]);

/** Over-fetch this many candidates per gateway, then keep the best few. */
const CANDIDATE_POOL = 10;

async function categorySearch(
  cfg: CategoryTool,
  input: Record<string, unknown>,
  book: SourceBook,
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
  const keep = clamp(input["limit"], 4, 6);

  // Recency anchor: an undated query on a live matter ranks stale top hits
  // first. When the model gave no year/date, append the current month+year for
  // the recency-sensitive gateways (news, case law, enforcement) so the newest
  // orders and coverage surface. Static text (CFR, statutes, science) is left
  // alone — dating those queries only adds noise.
  const dateSensitive = RECENCY_GATEWAYS.has(cfg.gateway);
  const hasDate = /\b(19|20)\d{2}\b|\b(last|past|recent|latest|today|this (week|month|year))\b/i.test(query);
  const effectiveQuery = dateSensitive && !hasDate ? `${query} ${currentMonthYear()}` : query;
  const recency = dateSensitive || wantsRecency(query);

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
  if (dateSensitive && hasDate && !effectiveQuery.includes(currentMonthYear()) && variants.length < 3) {
    const anchored = `${query} ${currentMonthYear()}`;
    if (!variants.some((v) => v.toLowerCase() === anchored.toLowerCase())) variants.push(anchored);
  }

  const fetchPool = (q: string) =>
    memoTTL(
      // Cache raw gateway hits (not the [S#]-tagged outcome): a repeat of the
      // same category+query within the window reuses one upstream call, and
      // SourceBook still assigns this run's own refs below.
      toolCacheKey(`ac:${cfg.gateway}`, { query: q, limit: CANDIDATE_POOL }),
      TOOL_CACHE_TTL_MS,
      () => agentCoreSearch(cfg.gateway, q, CANDIDATE_POOL),
    );

  let results;
  try {
    const pools = await Promise.all(variants.map((q) => fetchPool(q)));
    results = pools.flat();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "search failed";
    return { text: `${cfg.name} failed: ${trunc(msg, 220)}`, hits: 0, refs: [] };
  }

  if (!results.length) return { text: `No ${cfg.name} results for "${query}".`, hits: 0, refs: [] };

  const seen = seenFor(book);
  let ranked = rankResults(results, {
    query,
    keep,
    recency,
    sourceType: cfg.sourceType,
    seen,
  });

  // One tightened retry when a recency question came back with nothing from the
  // last ~12 months — better than silently accepting stale top hits.
  if (recency && allStale(ranked)) {
    try {
      const retry = await fetchPool(`${query} ${new Date().getUTCFullYear()}`);
      const rankedRetry = rankResults(retry, {
        query,
        keep,
        recency,
        sourceType: cfg.sourceType,
        seen,
      });
      if (rankedRetry.length && !allStale(rankedRetry)) ranked = rankedRetry;
      else if (!ranked.length) ranked = rankedRetry;
    } catch {
      /* keep what we have */
    }
  }

  if (!ranked.length)
    return {
      text: `No ${cfg.name} result added new on-point material for "${query}" (already-seen or off-topic hits filtered).`,
      hits: 0,
      refs: [],
    };

  const refs: string[] = [];
  const lines = ranked.map(({ result: r, evidence, date, superseded }) => {
    const src = book.add({
      citation: r.title || r.url || `${cfg.name} result`,
      authority: "web",
      source_type: cfg.sourceType,
      source_url: r.url,
      effective_date: date ?? r.published,
      is_current: !superseded,
      // Full text stays on the source for citation/reading; only the prompt
      // gets the extract.
      content: trunc(r.text ?? "", 1500),
    });
    refs.push(src.ref);
    const stamp = date ? `as of ${date}` : "date: unknown";
    const flag = superseded ? " [SUPERSEDED — a newer source on this subject is in this list; prefer it]" : "";
    return `[${src.ref}] ${r.title ?? ""} — ${r.url ?? ""} (${stamp})${flag}\n${evidence}`;
  });

  return { text: lines.join("\n\n"), hits: ranked.length, refs };
}

/** Fan-out: 2-3 gateways in one model turn instead of one turn each. */
async function multiCategorySearch(
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };
  const raw = Array.isArray(input["categories"]) ? (input["categories"] as unknown[]) : [];
  const cfgs = raw
    .map((c) => CATEGORY_BY_NAME.get(str(c)))
    .filter((c): c is CategoryTool => !!c)
    .slice(0, 3);
  if (!cfgs.length)
    return {
      text: `No valid categories. Pick 2-3 of: ${CATEGORY_TOOLS.map((t) => t.name).join(", ")}.`,
      hits: 0,
      refs: [],
    };

  const limit = clamp(input["limit"], 4, 6);
  const queries = Array.isArray(input["queries"]) ? input["queries"] : undefined;
  const outcomes = await Promise.all(
    cfgs.map((cfg) => categorySearch(cfg, { query, queries, limit }, book)),
  );
  return {
    text: outcomes.map((o, i) => `### ${cfgs[i]!.name}\n${o.text}`).join("\n\n"),
    hits: outcomes.reduce((n, o) => n + o.hits, 0),
    refs: outcomes.flatMap((o) => o.refs),
  };
}


// --- DocketBird execution --------------------------------------------------

const stripEm = (s: string) => s.replace(/<\/?em>/gi, "");

async function dbSearchFilings(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return { text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).", hits: 0, refs: [] };
  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };

  const searchArgs = {
    q: query,
    caseId: str(input["case_id"]) || undefined,
    courtId: str(input["court_id"]) || undefined,
    filedAfter: str(input["filed_after"]) || undefined,
    filedBefore: str(input["filed_before"]) || undefined,
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
    return { text: `DocketBird search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
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

async function dbReadFiling(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return { text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).", hits: 0, refs: [] };
  const id = str(input["document_id"]);
  if (!id) return { text: "document_id is required.", hits: 0, refs: [] };

  let doc: { id: string; title: string; text: string };
  try {
    doc = await memoTTL(
      toolCacheKey("db_read", { id }),
      TOOL_CACHE_TTL_MS,
      () => getFilingText(id),
    );
  } catch (err) {
    return { text: `Could not read filing ${id}: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!doc.text.trim()) return { text: `No extracted text available for document ${id}.`, hits: 0, refs: [] };

  const content = trunc(doc.text, 6000);
  const src = book.add({
    citation: doc.title || `DocketBird document ${id}`,
    authority: "registry",
    source_type: "filing",
    section_path: id,
    content,
  });
  return { text: `[${src.ref}] document_id=${id}\n${doc.title}\n${content}`, hits: 1, refs: [src.ref] };
}

async function dbGetCase(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured())
    return { text: "DocketBird is not configured (DOCKETBIRD_API_KEY missing).", hits: 0, refs: [] };
  const id = str(input["case_id"]);
  if (!id) return { text: "case_id is required.", hits: 0, refs: [] };

  let c: DbCase | null;
  try {
    c = await memoTTL<DbCase | null>(
      toolCacheKey("db_case", { id }),
      TOOL_CACHE_TTL_MS,
      () => dbGetCaseApi(id),
    );
  } catch (err) {
    return { text: `Could not load case ${id}: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!c) return { text: `No case with id "${id}".`, hits: 0, refs: [] };

  const content = [
    `${c.title} — ${c.court_id}`,
    c.case_number ? `Case no. ${c.case_number}` : "",
    c.date_filed ? `Filed ${c.date_filed}` : "",
    c.complaint_document_id ? `Complaint document_id: ${c.complaint_document_id} (${c.complaint_status ?? "?"})` : "",
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
const dbCaseUrl = (id: string) => `https://www.docketbird.com/cases?case_id=${encodeURIComponent(id)}`;

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
    return { text: `Case search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No cases match "${query}"${courtId ? " in that court" : ""}.`, hits: 0, refs: [] };

  const refs: string[] = [];
  const lines = hits.map((c) => {
    const cite = `${c.title} (${c.court_name || c.court_id})${c.case_number ? `, No. ${c.case_number}` : ""}`;
    const content = [
      cite,
      c.date_filed ? `Filed ${c.date_filed}` : c.year_filed ? `Filed ${c.year_filed}` : "",
      c.complaint_document_id ? `Complaint document_id: ${c.complaint_document_id} (${c.complaint_status ?? "?"})` : "",
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

async function dbDocketSheet(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const caseId = str(input["case_id"]);
  if (!caseId) return { text: "case_id is required — resolve the case with db_find_case first.", hits: 0, refs: [] };
  const sort = str(input["sort"]) === "chronological" ? "chronological" : "recent";
  const limit = clamp(input["limit"], 20, 40);

  let rows;
  try {
    rows = await memoTTL(
      toolCacheKey("db_docket", { case: caseId, sort }),
      TOOL_CACHE_TTL_MS,
      () => getDocketSheet(caseId, sort as "chronological" | "recent"),
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
    .map((e) => `- ${e.date_filed ?? "(no date)"} — ${e.title || "(untitled entry)"} [document_id=${e.id}]`)
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
  if (!caseId) return { text: "case_id is required — resolve the case with db_find_case first.", hits: 0, refs: [] };

  let entries;
  try {
    entries = await memoTTL(
      toolCacheKey("db_cal", { case: caseId }),
      TOOL_CACHE_TTL_MS,
      () => getCalendar(caseId),
    );
  } catch (err) {
    return { text: `Could not load the calendar for ${caseId}: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!entries.length)
    return {
      text: `No calendar entries for ${caseId}. The firm may not be tracking this case — this is not evidence that the case has no deadlines.`,
      hits: 0,
      refs: [],
    };

  const list = entries.slice(0, 40).map((e) => `- ${trunc(JSON.stringify(e), 300)}`).join("\n");
  const src = book.add({
    citation: `Calendar / deadlines — ${caseId}`,
    authority: "registry",
    source_type: "calendar",
    section_path: `${caseId}|calendar`,
    source_url: dbCaseUrl(caseId),
    content: trunc(list, 4000),
  });
  return { text: `[${src.ref}] Calendar entries for ${caseId}:\n${list}`, hits: entries.length, refs: [src.ref] };
}

async function dbGraphAsk(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!docketbirdConfigured()) return DB_NOT_CONFIGURED;
  const question = str(input["question"]);
  if (question.length < 5) return { text: "A question is required.", hits: 0, refs: [] };

  let r;
  try {
    r = await memoTTL(
      toolCacheKey("db_graph", { q: question }),
      TOOL_CACHE_TTL_MS,
      () => graphAsk(question),
    );
  } catch (err) {
    return { text: `Litigation graph query failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
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
