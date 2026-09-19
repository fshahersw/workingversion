// ============================================================================
// Public-law source registry: per-domain governance for research retrieval.
//
// Backed by source-domains.gen.ts (2,000+ domains from the liveness-verified
// registry). Answers three questions the research tools need, deterministically
// and without any network call:
//
//   1. Is this an official/authoritative source, and was it live when the
//      registry last verified it?          -> sourceTrust(url).official/livePct
//   2. May we send it to a rendering scraper? The registry authors mark
//      `crawl_policy` never (site forbids automated retrieval) or verify_only
//      (link/HEAD only).                   -> scrapeAllowed(url)
//   3. How should the model see it?        -> sourceNote(url)
//
// Lookups walk parent domains ("ecf.alnd.uscourts.gov" -> "alnd.uscourts.gov"
// -> "uscourts.gov") so subdomains inherit their registry parent. Large table:
// import from server modules only (the client-safe court directory is separate).
// ============================================================================
import { SOURCE_DOMAINS, SOURCE_DOMAINS_AS_OF, type SourceDomainRow } from "./data/source-domains.gen";

export type CrawlPolicy = "open" | "verify_only" | "never";
export type SourceType = "official" | "nonprofit" | "commercial" | "institutional" | "unknown";

export type SourceTrust = {
  /** a registry domain matched (exactly or as a parent) */
  known: boolean;
  /** the matched registry domain */
  domain: string | null;
  type: SourceType;
  official: boolean;
  /** share of this domain's registry URLs that answered 200 at verification (0-100) */
  livePct: number;
  /** registry records under this domain */
  records: number;
  policy: CrawlPolicy;
  /** non-open access notes ("registration", "fee", "dua"), empty when open */
  access: string[];
  /** the app ingests this source into its own corpus (registry backend=corpus) */
  inCorpus: boolean;
  asOf: string;
};

const TYPE: Record<string, SourceType> = { o: "official", n: "nonprofit", c: "commercial", i: "institutional" };

const BY_DOMAIN = new Map<string, SourceDomainRow>(SOURCE_DOMAINS.map((r) => [r[0], r] as const));

function hostOf(urlOrHost: string): string {
  const s = urlOrHost.trim();
  try {
    return (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? new URL(s).hostname : s).toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Registry row for a hostname, walking up parent domains; null when unknown. */
export function sourceDomainRow(urlOrHost: string): SourceDomainRow | null {
  let host = hostOf(urlOrHost);
  while (host && host.includes(".")) {
    const row = BY_DOMAIN.get(host);
    if (row) return row;
    host = host.slice(host.indexOf(".") + 1);
  }
  return null;
}

const UNKNOWN: SourceTrust = {
  known: false,
  domain: null,
  type: "unknown",
  official: false,
  livePct: 0,
  records: 0,
  policy: "open",
  access: [],
  inCorpus: false,
  asOf: SOURCE_DOMAINS_AS_OF,
};

export function sourceTrust(urlOrHost: string): SourceTrust {
  const row = sourceDomainRow(urlOrHost);
  if (!row) return UNKNOWN;
  const [domain, type, policy, access, livePct, records, , , inCorpus] = row;
  return {
    known: true,
    domain,
    type: TYPE[type] ?? "unknown",
    official: type === "o",
    livePct,
    records,
    policy: policy === "never" ? "never" : policy === "verify_only" ? "verify_only" : "open",
    access: access ? access.split(",").filter(Boolean) : [],
    inCorpus: inCorpus === 1,
    asOf: SOURCE_DOMAINS_AS_OF,
  };
}

/**
 * False when the registry says this source must not be sent to a rendering
 * scraper or crawler (`never`) or should only be verified, not retrieved, by
 * automation (`verify_only`). Unknown domains are allowed: the registry is a
 * governance overlay, not an allow-list.
 */
export function scrapeAllowed(urlOrHost: string): boolean {
  return sourceTrust(urlOrHost).policy === "open";
}

/**
 * Compact, model-facing provenance note for a fetched source, or "" when the
 * registry does not know the domain. Never claims liveness the registry did
 * not observe (a domain that mostly answered 403 at verification is "listed",
 * not "verified live").
 */
export function sourceNote(urlOrHost: string): string {
  const t = sourceTrust(urlOrHost);
  if (!t.known) return "";
  const kind = t.official ? "official source" : t.type === "nonprofit" ? "nonprofit/association source" : t.type === "institutional" ? "institutional source" : "third-party source";
  const live = t.livePct >= 50 ? `registry-verified live ${t.asOf}` : `listed in the source registry (${t.livePct}% live at ${t.asOf} verification)`;
  const access = t.access.length ? `; access: ${t.access.join(", ")}` : "";
  return `${kind}, ${live}${access}`;
}

/** Table size and vintage, for logs and health checks. */
export function sourceRegistryStats(): { domains: number; official: number; asOf: string } {
  let official = 0;
  for (const r of SOURCE_DOMAINS) if (r[1] === "o") official++;
  return { domains: SOURCE_DOMAINS.length, official, asOf: SOURCE_DOMAINS_AS_OF };
}
