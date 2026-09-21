// ============================================================================
// Resilient page reader (server-only): the ladder every "read this URL" tool
// climbs, fastest rung first, escalating only on a deterministic block.
//
//   1. fetchPage        direct, SSRF-hardened, PDF text layer included   ~0.3–1.5 s
//   2. Firecrawl scrape rendering scraper with anti-bot handling, main    ~2–6 s
//                       content as markdown (FIRECRAWL_API_KEY)
//   3. Tavily extract   extraction service (TAVILY_API_KEY)               ~2–5 s
//
// Each rung is time-capped; a rung that is not configured is skipped. The
// result says which rung answered so the model (and the citation verifier)
// know the text is the page's content and how it was obtained. Login and
// paywall pages are never retried: no rung can or should get past them.
// Design per referenceforagentarchitecture.md §1.2 (deterministic sources
// before browsing) — an AgentCore Browser rung belongs after these, capped,
// once their failure rate is measured.
// ============================================================================
import { scrapeAllowed, sourceTrust } from "@/lib/legal/source-registry";

import { fetchPage, type FetchPageOptions, type FetchedPage } from "./fetch-page.server";
import { agentLog, trunc } from "./log.server";
import { classifyPage, viaNote, type BlockVerdict } from "./page-block";

export type ReadVia = "direct" | "firecrawl" | "tavily";

export type ReadPageResult = FetchedPage & {
  via: ReadVia;
  /** why the direct fetch was not used (null when it was) */
  blocked: BlockVerdict | null;
  /**
   * Source-registry provenance for the host: official/nonprofit/commercial,
   * liveness share at the registry's verification date, crawl policy. Unknown
   * hosts report known=false; nothing here is fetched.
   */
  source: ReturnType<typeof sourceTrust>;
};

export type ReadPageOptions = FetchPageOptions & {
  /** disable the scraper fallbacks (default: enabled when configured) */
  fallbacks?: boolean;
  /** per-fallback wall-clock cap (default 12 s) */
  fallbackTimeoutMs?: number;
  /** test seams */
  firecrawl?: (url: string, ms: number, signal?: AbortSignal) => Promise<ScrapeResult | null>;
  tavily?: (url: string, ms: number, signal?: AbortSignal) => Promise<ScrapeResult | null>;
};

export type ScrapeResult = { title: string; text: string; finalUrl?: string };

const FIRECRAWL_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";
const DEFAULT_FALLBACK_MS = 12_000;

function key(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** RESEARCH_SOURCE_REGISTRY=off disables the registry crawl-policy overlay. */
function registryPolicyEnabled(): boolean {
  return (process.env["RESEARCH_SOURCE_REGISTRY"] ?? "on").trim().toLowerCase() !== "off";
}

// --- Provider circuit breaker ---------------------------------------------------
//
// A scraper whose key is exhausted or revoked answers every call with 401/402/403
// in a few hundred ms. Without a breaker each blocked page pays that round trip
// before the next rung; with one, the rung is skipped for a cooling period after
// a few consecutive auth/quota failures and re-tried afterwards. Only auth/quota
// statuses trip it: a 5xx or a timeout is a transient the next call may not see.

const BREAKER_TRIP_AFTER = 3;
const BREAKER_COOL_MS = Number(process.env["RESEARCH_SCRAPER_BREAKER_MS"]) || 10 * 60_000;
type Breaker = { failures: number; openUntil: number; lastStatus: number };
const breakers = new Map<ReadVia, Breaker>();

function breaker(via: ReadVia): Breaker {
  let b = breakers.get(via);
  if (!b) breakers.set(via, (b = { failures: 0, openUntil: 0, lastStatus: 0 }));
  return b;
}
function breakerOpen(via: ReadVia): boolean {
  return breaker(via).openUntil > Date.now();
}
function noteProviderStatus(via: ReadVia, status: number): void {
  const b = breaker(via);
  if (status === 401 || status === 402 || status === 403) {
    b.failures++;
    b.lastStatus = status;
    if (b.failures >= BREAKER_TRIP_AFTER && b.openUntil <= Date.now()) {
      b.openUntil = Date.now() + BREAKER_COOL_MS;
      agentLog("read_page_provider_paused", { via, status, cool_ms: BREAKER_COOL_MS });
    }
  } else if (status >= 200 && status < 300) {
    b.failures = 0;
    b.openUntil = 0;
  }
}
/** Test seam: clear breaker state. */
export function resetReadPageBreakers(): void {
  breakers.clear();
}

function withTimeout(ms: number, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  const onParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** Firecrawl v2 scrape: rendered page, main content as markdown. */
export async function firecrawlScrape(
  url: string,
  ms: number,
  parent?: AbortSignal,
): Promise<ScrapeResult | null> {
  const apiKey = key("FIRECRAWL_API_KEY");
  if (!apiKey) return null;
  const t = withTimeout(ms, parent);
  try {
    const res = await fetch(FIRECRAWL_SCRAPE, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        // wait for client rendering; the cap above bounds the whole call
        waitFor: 1500,
        timeout: Math.max(5_000, ms - 1_500),
      }),
      signal: t.signal,
    });
    noteProviderStatus("firecrawl", res.status);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string; statusCode?: number } };
    };
    const md = json.data?.markdown?.trim() ?? "";
    if (!json.success || !md) return null;
    return {
      title: json.data?.metadata?.title?.trim() ?? "",
      text: md,
      ...(json.data?.metadata?.sourceURL ? { finalUrl: json.data.metadata.sourceURL } : {}),
    };
  } catch {
    return null;
  } finally {
    t.done();
  }
}

/** Tavily extract: raw page content for one URL. */
export async function tavilyExtract(
  url: string,
  ms: number,
  parent?: AbortSignal,
): Promise<ScrapeResult | null> {
  const apiKey = key("TAVILY_API_KEY");
  if (!apiKey) return null;
  const t = withTimeout(ms, parent);
  try {
    const res = await fetch(TAVILY_EXTRACT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url], extract_depth: "advanced", format: "markdown" }),
      signal: t.signal,
    });
    noteProviderStatus("tavily", res.status);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      results?: { url?: string; raw_content?: string; title?: string }[];
    };
    const hit = json.results?.[0];
    const text = hit?.raw_content?.trim() ?? "";
    if (!text) return null;
    return { title: hit?.title?.trim() ?? "", text, ...(hit?.url ? { finalUrl: hit.url } : {}) };
  } catch {
    return null;
  } finally {
    t.done();
  }
}

function fromScrape(
  base: FetchedPage,
  scraped: ScrapeResult,
  via: ReadVia,
  verdict: BlockVerdict,
  maxChars: number,
): ReadPageResult {
  const text = scraped.text.slice(0, maxChars);
  const note = [viaNote(via, verdict), base.note].filter(Boolean).join(" ");
  return {
    ...base,
    finalUrl: scraped.finalUrl || base.finalUrl,
    title: scraped.title || base.title,
    text,
    truncated: scraped.text.length > maxChars,
    ...(note ? { note } : {}),
    via,
    blocked: verdict,
    source: sourceTrust(base.url),
  };
}

/**
 * Read a URL for the model. Same contract as fetchPage plus `via`/`blocked`.
 * Never throws for a blocked page: the caller gets the direct result with
 * `blocked` set when every rung failed, so it can tell the user precisely why.
 * Genuine transport failures (DNS, SSRF refusal, timeout) still throw.
 */
export async function readPage(url: string, opts?: ReadPageOptions): Promise<ReadPageResult> {
  const maxChars = opts?.maxChars ?? 12_000;
  const started = Date.now();
  let direct: FetchedPage;
  let transportError: Error | null = null;
  try {
    direct = await fetchPage(url, opts);
  } catch (error) {
    // A refused/unreachable host may still be reachable to a scraper (e.g. a
    // TLS or HTTP/2 quirk on our side); treat it as a retryable block. SSRF
    // refusals and aborts are not retried.
    const message = error instanceof Error ? error.message : String(error);
    if (opts?.signal?.aborted || /Blocked|private|metadata|loopback|link-local|Invalid URL|Unsupported protocol/i.test(message))
      throw error;
    transportError = error instanceof Error ? error : new Error(message);
    direct = {
      url,
      finalUrl: url,
      status: 0,
      contentType: "",
      title: "",
      text: "",
      links: [],
      truncated: false,
      note: `Direct fetch failed: ${trunc(message, 160)}`,
    };
  }

  const verdict: BlockVerdict = transportError
    ? { blocked: true, reason: "http-status", detail: trunc(transportError.message, 120), retryable: true }
    : classifyPage(direct);

  const source = sourceTrust(url);
  if (!verdict.blocked) {
    return { ...direct, via: "direct", blocked: null, source };
  }
  const fallbacks = opts?.fallbacks ?? true;
  if (!fallbacks || !verdict.retryable) {
    agentLog("read_page_blocked", { host: safeHost(url), reason: verdict.reason, retryable: verdict.retryable });
    return { ...direct, via: "direct", blocked: verdict, source };
  }
  // The public-law source registry marks a few hosts as never-crawl (the site
  // forbids automated retrieval) or verify-only. Those are read directly or not
  // at all; they are never handed to a third-party scraper.
  if (registryPolicyEnabled() && !scrapeAllowed(url)) {
    agentLog("read_page_policy", { host: safeHost(url), policy: source.policy, reason: verdict.reason });
    return {
      ...direct,
      note: [
        `The page could not be read directly (${verdict.detail}), and this source's registry crawl policy (${source.policy}) does not permit a rendering scraper. Cite it by URL or use its official search instead.`,
        direct.note,
      ]
        .filter(Boolean)
        .join(" "),
      via: "direct",
      blocked: verdict,
      source,
    };
  }

  const ms = opts?.fallbackTimeoutMs ?? DEFAULT_FALLBACK_MS;
  const rungs: Array<[ReadVia, NonNullable<ReadPageOptions["firecrawl"]>]> = [
    ["firecrawl", opts?.firecrawl ?? firecrawlScrape],
    ["tavily", opts?.tavily ?? tavilyExtract],
  ];
  for (const [via, run] of rungs) {
    if (breakerOpen(via)) continue; // key exhausted/revoked a moment ago; skip the round trip
    const scraped = await run(url, ms, opts?.signal);
    if (!scraped) continue;
    const probe = classifyPage({
      status: 200,
      contentType: "text/markdown",
      title: scraped.title,
      text: scraped.text,
    });
    if (probe.blocked) continue; // the scraper hit the same wall
    agentLog("read_page_fallback", {
      host: safeHost(url),
      via,
      reason: verdict.reason,
      chars: scraped.text.length,
      ms: Date.now() - started,
    });
    return fromScrape(direct, scraped, via, verdict, maxChars);
  }
  agentLog("read_page_blocked", { host: safeHost(url), reason: verdict.reason, fallbacks: rungs.length, ms: Date.now() - started });
  return {
    ...direct,
    note: [
      `The page could not be read (${verdict.detail}); the rendering fallbacks were also blocked or unavailable.`,
      direct.note,
    ]
      .filter(Boolean)
      .join(" "),
    via: "direct",
    blocked: verdict,
    source,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}
