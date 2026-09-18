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
import { fetchPage, type FetchPageOptions, type FetchedPage } from "./fetch-page.server";
import { agentLog, trunc } from "./log.server";
import { classifyPage, viaNote, type BlockVerdict } from "./page-block";

export type ReadVia = "direct" | "firecrawl" | "tavily";

export type ReadPageResult = FetchedPage & {
  via: ReadVia;
  /** why the direct fetch was not used (null when it was) */
  blocked: BlockVerdict | null;
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

  if (!verdict.blocked) {
    return { ...direct, via: "direct", blocked: null };
  }
  const fallbacks = opts?.fallbacks ?? true;
  if (!fallbacks || !verdict.retryable) {
    agentLog("read_page_blocked", { host: safeHost(url), reason: verdict.reason, retryable: verdict.retryable });
    return { ...direct, via: "direct", blocked: verdict };
  }

  const ms = opts?.fallbackTimeoutMs ?? DEFAULT_FALLBACK_MS;
  const rungs: Array<[ReadVia, NonNullable<ReadPageOptions["firecrawl"]>]> = [
    ["firecrawl", opts?.firecrawl ?? firecrawlScrape],
    ["tavily", opts?.tavily ?? tavilyExtract],
  ];
  for (const [via, run] of rungs) {
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
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}
