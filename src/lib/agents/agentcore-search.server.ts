// ============================================================================
// AWS Bedrock AgentCore web search (server-only).
//
// The research sub-agents search the web through the account's IAM AgentCore
// gateway (ClaudeAddinWebSearchIamGateway) — the same secure, admin-domain-
// filtered connector the Office add-in backend uses. One MCP tool,
// `general___WebSearch`, reached by a single SigV4-signed POST (JSON-RPC 2.0
// tools/call) under the "bedrock-agentcore" service.
//
// Auth is SigV4 via the DEFAULT CREDENTIAL CHAIN (SSO in dev, the app IAM role
// in prod) — see bedrock-sign.server.ts. No static SEARCH_AWS_* keys, no bearer
// token, no MCP initialize handshake.
//
// The seven category tools in tools.server.ts all route here; per-category
// scoping (domainFilter) can be layered on later via DOMAIN_FILTERS — today the
// connector's admin-level domain allow-list already keeps results authoritative.
// ============================================================================
import { loadAgentCoreConfig } from "../config.server";
import { signedAwsFetch } from "./bedrock-sign.server";
import { EXCLUDED_DOMAINS } from "./web-rank";

// This gateway negotiates MCP 2025-03-26 (not the newer 2025-11-25).
const PROTOCOL_VERSION = "2025-03-26";
const JSONRPC_ID = 1;

/**
 * Category keys the research agent's single `web_search` tool exposes. All route
 * to the ONE AgentCore gateway tool; each carries a curated authoritative
 * domain allow-list (DOMAIN_FILTERS) sent PER REQUEST as filters.domainFilter.
 * `general_web` is the deliberate exception — no allow-list, so it runs an open
 * web search with only the junk-domain EXCLUDE guardrail applied.
 */
export type GatewayKey =
  | "federal_case_law"
  | "state_case_law"
  | "mdl_class_action"
  | "statutes_legislation"
  | "congressional"
  | "federal_regulations"
  | "state_ag_regulatory"
  | "sec_securities"
  | "fda_drug_device"
  | "agency_enforcement"
  | "scientific_medical"
  | "clinical_trials_safety"
  | "environmental_tox"
  | "company_business"
  | "judges_attorneys"
  | "legal_news"
  | "general_web";

/**
 * Per-category domain allow-lists (request-level filters.domainFilter.include,
 * confirmed honored by the connector). Curated toward PRIMARY and authoritative
 * sources and deliberately AVOIDING the lead-gen / aggregator hosts web-rank.ts
 * drops (topclassactions, classaction, drugwatch, avvo, ...) so an include never
 * fetches a host the ranker discards. `include` is a whitelist: only these
 * domains (and their subdomains) return. `general_web` has NO entry on purpose
 * -> open search with the EXCLUDED_DOMAINS guardrail (see buildFilters).
 */
const DOMAIN_FILTERS: Partial<Record<GatewayKey, string[]>> = {
  federal_case_law: [
    "courtlistener.com", "supremecourt.gov", "uscourts.gov", "govinfo.gov", "gpo.gov",
    "law.cornell.edu", "justia.com", "casetext.com", "vlex.com", "fastcase.com",
    "casemine.com", "leagle.com", "openjurist.org", "plol.org", "oyez.org",
    "scholar.google.com", "findlaw.com", "anylaw.com", "scotusblog.com", "ssrn.com",
    "jdsupra.com", "natlawreview.com", "americanbar.org", "abajournal.com", "law360.com",
    "bloomberglaw.com", "reuters.com", "harvardlawreview.org", "columbialawreview.org", "yalelawjournal.org",
  ],
  state_case_law: [
    "courtlistener.com", "justia.com", "casetext.com", "vlex.com", "fastcase.com",
    "casemine.com", "findlaw.com", "leagle.com", "trellis.law", "unicourt.com",
    "nycourts.gov", "courts.ca.gov", "lacourt.org", "njcourts.gov", "pacourts.us",
    "txcourts.gov", "illinoiscourts.gov", "flcourts.gov", "courts.mi.gov", "mass.gov",
    "nccourts.gov", "courts.wa.gov", "courts.mo.gov", "mncourts.gov", "sccourts.org",
    "mdcourts.gov", "gacourts.gov", "courts.delaware.gov", "azcourts.gov", "utcourts.gov",
  ],
  mdl_class_action: [
    "jpml.uscourts.gov", "uscourts.gov", "courtlistener.com", "govinfo.gov", "bloomberglaw.com",
    "law360.com", "reuters.com", "law.com", "courthousenews.com", "jdsupra.com",
    "lexology.com", "natlawreview.com", "abajournal.com", "americanbar.org", "duanemorris.com",
    "securities.stanford.edu", "epiqglobal.com", "angeiongroup.com", "kroll.com", "jndla.com",
    "gilardi.com", "simpluris.com", "dahladministration.com", "bmcgroup.com", "rustconsulting.com",
    "prnewswire.com", "businesswire.com", "globenewswire.com",
  ],
  statutes_legislation: [
    "congress.gov", "govinfo.gov", "gpo.gov", "uscode.house.gov", "law.cornell.edu",
    "govtrack.us", "legiscan.com", "openstates.org", "ncsl.org", "uniformlaws.org",
    "ali.org", "loc.gov", "justia.com", "findlaw.com", "leginfo.legislature.ca.gov",
    "nysenate.gov", "nyassembly.gov", "njleg.gov", "capitol.texas.gov", "ilga.gov",
    "flsenate.gov", "legislature.mi.gov", "billtrack50.com", "plol.org",
  ],
  congressional: [
    "congress.gov", "house.gov", "senate.gov", "govinfo.gov", "gpo.gov",
    "gao.gov", "crsreports.congress.gov", "everycrsreport.com", "cbo.gov", "c-span.org",
    "whitehouse.gov", "reginfo.gov", "govtrack.us", "propublica.org", "rollcall.com",
    "thehill.com", "politico.com", "loc.gov", "judiciary.senate.gov", "energycommerce.house.gov",
    "oversight.house.gov", "help.senate.gov", "finance.senate.gov", "commerce.senate.gov",
  ],
  federal_regulations: [
    "federalregister.gov", "regulations.gov", "ecfr.gov", "reginfo.gov", "govinfo.gov",
    "gpo.gov", "whitehouse.gov", "law.cornell.edu", "acus.gov", "fda.gov",
    "epa.gov", "ftc.gov", "cpsc.gov", "nhtsa.gov", "osha.gov",
    "cms.gov", "sec.gov", "fcc.gov", "dol.gov", "hhs.gov", "uspto.gov", "energy.gov",
  ],
  state_ag_regulatory: [
    "naag.org", "oag.ca.gov", "oehha.ca.gov", "dtsc.ca.gov", "ag.ny.gov",
    "nj.gov", "attorneygeneral.gov", "texasattorneygeneral.gov", "illinoisattorneygeneral.gov", "myfloridalegal.com",
    "ncdoj.gov", "ohioattorneygeneral.gov", "atg.wa.gov", "coag.gov", "ago.mo.gov",
    "mass.gov", "oag.dc.gov", "michigan.gov", "ncsl.org", "csg.org", "naic.org", "cdph.ca.gov",
  ],
  sec_securities: [
    "sec.gov", "pcaobus.org", "finra.org", "investor.gov", "securities.stanford.edu",
    "cornerstone.com", "sec.report", "bamsec.com", "last10k.com", "annualreports.com",
    "msrb.org", "sipc.org", "nasaa.org", "issgovernance.com", "fasb.org",
    "cfainstitute.org", "bloomberglaw.com", "bloomberg.com", "reuters.com", "wsj.com",
    "marketwatch.com", "law360.com",
  ],
  fda_drug_device: [
    "fda.gov", "api.fda.gov", "dailymed.nlm.nih.gov", "medlineplus.gov", "nih.gov",
    "ncbi.nlm.nih.gov", "drugs.com", "rxlist.com", "fda.report", "recalls.gov",
    "ema.europa.eu", "who.int", "raps.org", "fiercepharma.com", "fiercebiotech.com",
    "endpts.com", "statnews.com", "biospace.com", "fdanews.com", "regulations.gov",
    "reuters.com", "bloomberglaw.com",
  ],
  agency_enforcement: [
    "ftc.gov", "cpsc.gov", "saferproducts.gov", "nhtsa.gov", "epa.gov",
    "osha.gov", "cms.gov", "hhs.gov", "oig.hhs.gov", "justice.gov",
    "consumerfinance.gov", "recalls.gov", "sec.gov", "fdic.gov", "occ.gov",
    "federalreserve.gov", "faa.gov", "usda.gov", "fsis.usda.gov", "dol.gov",
    "msha.gov", "dea.gov", "treasury.gov", "fincen.gov", "fcc.gov", "fec.gov",
  ],
  scientific_medical: [
    "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "nih.gov", "nlm.nih.gov", "who.int",
    "cochranelibrary.com", "nejm.org", "jamanetwork.com", "thelancet.com", "bmj.com",
    "sciencedirect.com", "nature.com", "cell.com", "springer.com", "onlinelibrary.wiley.com",
    "academic.oup.com", "tandfonline.com", "sagepub.com", "plos.org", "pnas.org",
    "science.org", "medrxiv.org", "biorxiv.org", "semanticscholar.org", "europepmc.org",
    "medlineplus.gov", "cdc.gov", "ahrq.gov", "nasem.org", "annals.org",
  ],
  clinical_trials_safety: [
    "clinicaltrials.gov", "who.int", "clinicaltrialsregister.eu", "euclinicaltrials.eu", "ema.europa.eu",
    "dailymed.nlm.nih.gov", "api.fda.gov", "fis.fda.gov", "vaers.hhs.gov", "wonder.cdc.gov",
    "cdc.gov", "fda.gov", "accessdata.fda.gov", "isrctn.com", "anzctr.org.au",
    "pmda.go.jp", "gov.uk", "ncbi.nlm.nih.gov", "cochranelibrary.com", "openpaymentsdata.cms.gov",
    "cms.gov", "nih.gov",
  ],
  environmental_tox: [
    "epa.gov", "cdc.gov", "atsdr.cdc.gov", "niehs.nih.gov", "ntp.niehs.nih.gov",
    "iarc.who.int", "iarc.fr", "who.int", "pubchem.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov",
    "usgs.gov", "noaa.gov", "osha.gov", "nih.gov", "nist.gov",
    "astm.org", "ansi.org", "asme.org", "acgih.org", "ul.com",
    "nfpa.org", "iso.org", "ieee.org", "energy.gov", "nsf.org", "aiha.org",
  ],
  company_business: [
    "sec.gov", "opencorporates.com", "sec.report", "bamsec.com", "annualreports.com",
    "dnb.com", "crunchbase.com", "hoovers.com", "bizapedia.com", "corporationwiki.com",
    "bizfileonline.sos.ca.gov", "dos.ny.gov", "sunbiz.org", "icis.corp.delaware.gov", "bloomberg.com",
    "reuters.com", "wsj.com", "ft.com", "cnbc.com", "forbes.com",
    "marketwatch.com", "stockanalysis.com", "businesswire.com", "prnewswire.com", "globenewswire.com",
  ],
  judges_attorneys: [
    "courtlistener.com", "fjc.gov", "uscourts.gov", "supremecourt.gov", "ballotpedia.org",
    "govinfo.gov", "congress.gov", "judiciary.senate.gov", "ncsc.org", "americanbar.org",
    "abajournal.com", "calbar.ca.gov", "nysba.org", "floridabar.org", "texasbar.com",
    "iardc.org", "dcbar.org", "njcourts.gov", "nycourts.gov", "law.com",
    "bloomberglaw.com", "law360.com", "oyez.org", "jdsupra.com",
  ],
  legal_news: [
    "law360.com", "reuters.com", "bloomberglaw.com", "bloomberg.com", "law.com",
    "courthousenews.com", "jdsupra.com", "natlawreview.com", "lexology.com", "abajournal.com",
    "apnews.com", "politico.com", "thehill.com", "statnews.com", "fiercepharma.com",
    "fiercebiotech.com", "endpts.com", "insidehealthpolicy.com", "legaldive.com", "abovethelaw.com",
    "legalnewsline.com", "harrismartin.com", "jurist.org", "wsj.com", "nytimes.com", "washingtonpost.com",
  ],
};

/** Normalize a caller's `published_after` (YYYY-MM-DD or ISO) to ISO-8601 UTC. */
function isoFrom(d?: string): string | undefined {
  if (!d) return undefined;
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Build the request-level `filters` object: per-category include (whitelist),
 *  else the junk-domain exclude for open search, plus an optional date floor.
 *  `openWeb` forces the exclude-only guardrail even for a whitelisted category —
 *  the escape hatch when a category's allow-list is what starved the results. */
function buildFilters(
  gatewayKey: GatewayKey,
  publishedAfter?: string,
  openWeb?: boolean,
): Record<string, unknown> | undefined {
  const filters: Record<string, unknown> = {};
  const include = openWeb ? undefined : DOMAIN_FILTERS[gatewayKey];
  if (include && include.length) filters["domainFilter"] = { include };
  else filters["domainFilter"] = { exclude: EXCLUDED_DOMAINS };
  const from = isoFrom(publishedAfter);
  if (from) filters["publishedDateFilter"] = { from };
  return Object.keys(filters).length ? filters : undefined;
}

export type GatewayResult = {
  title?: string;
  url?: string;
  text: string;
  published?: string;
};

export class AgentCoreSearchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AgentCoreSearchError";
  }
}

/** Search runs under the default AWS credential chain, resolved at call time
 *  (SSO in dev, the app role in prod). Always attempt it server-side. */
export function agentCoreConfigured(): boolean {
  loadAgentCoreConfig();
  return true;
}

// --- Response parsing ------------------------------------------------------

/** Handles both plain application/json and text/event-stream (SSE) framing. */
async function readPayloads(res: Response): Promise<Record<string, unknown>[]> {
  const contentType = res.headers.get("content-type") || "";
  const bodyText = await res.text();
  if (contentType.includes("event-stream")) {
    const out: Record<string, unknown>[] = [];
    for (const line of bodyText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === "[DONE]") continue;
      try {
        out.push(JSON.parse(chunk) as Record<string, unknown>);
      } catch {
        /* skip non-JSON keepalive frames */
      }
    }
    return out;
  }
  try {
    return [JSON.parse(bodyText) as Record<string, unknown>];
  } catch {
    return [];
  }
}

function extractResults(messages: Record<string, unknown>[]): GatewayResult[] {
  const message =
    messages.find((m) => m["id"] === JSONRPC_ID) ?? messages[messages.length - 1] ?? {};
  const result = message["result"];
  if (!result || typeof result !== "object") {
    const error = message["error"];
    throw new AgentCoreSearchError(
      502,
      error ? `Gateway error: ${JSON.stringify(error).slice(0, 300)}` : "No result block from gateway.",
    );
  }
  const r = result as Record<string, unknown>;
  if (r["isError"]) {
    throw new AgentCoreSearchError(502, `Search tool reported an error: ${JSON.stringify(r).slice(0, 300)}`);
  }

  const out: GatewayResult[] = [];
  const content = Array.isArray(r["content"]) ? (r["content"] as Record<string, unknown>[]) : [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block["type"] !== "text") continue;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(String(block["text"] ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const items = Array.isArray(inner["results"]) ? (inner["results"] as Record<string, unknown>[]) : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      out.push({
        title: typeof item["title"] === "string" ? item["title"] : undefined,
        url: typeof item["url"] === "string" ? item["url"] : undefined,
        text: typeof item["text"] === "string" ? item["text"] : "",
        published:
          typeof item["publishedDate"] === "string"
            ? item["publishedDate"]
            : typeof item["published"] === "string"
              ? item["published"]
              : undefined,
      });
    }
  }
  return out;
}

// --- Public API ------------------------------------------------------------

export async function agentCoreSearch(
  gatewayKey: GatewayKey,
  query: string,
  maxResults = 5,
  opts?: { signal?: AbortSignal; timeoutMs?: number; publishedAfter?: string; openWeb?: boolean },
): Promise<GatewayResult[]> {
  const q = (query || "").trim().slice(0, 200);
  if (!q) return [];

  const config = loadAgentCoreConfig();
  const args: Record<string, unknown> = {
    query: q,
    maxResults: Math.max(1, Math.min(Math.floor(maxResults || 5), 25)),
  };
  const filters = buildFilters(gatewayKey, opts?.publishedAfter, opts?.openWeb);
  if (filters) args["filters"] = filters;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: JSONRPC_ID,
    method: "tools/call",
    params: { name: config.toolName, arguments: args },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await signedAwsFetch("bedrock-agentcore", config.gatewayUrl, {
      body,
      headers: {
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new AgentCoreSearchError(
      0,
      `AgentCore search request failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentCoreSearchError(
      res.status,
      `AgentCore gateway returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  return extractResults(await readPayloads(res));
}
