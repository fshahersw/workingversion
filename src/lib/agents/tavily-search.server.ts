// ============================================================================
// Tavily Search API client (server-only). A THIRD web source merged in parallel
// with AgentCore + Brave for the RESEARCH agent (never the writer/Drafts path).
// Key from TAVILY_API_KEY; absent -> disabled (tavilyConfigured() === false), so
// nothing changes when it is unset. Results are mapped to the SAME shape
// agentCoreSearch/braveSearch return so the existing rankResults + EXCLUDED_DOMAINS
// + dedupe pipeline filters Tavily's output alongside the others.
// ============================================================================
import type { GatewayResult } from "./agentcore-search.server";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export function tavilyConfigured(): boolean {
  return !!process.env["TAVILY_API_KEY"]?.trim();
}

/** Map a YYYY-MM-DD lower bound to Tavily's coarse `time_range` bucket (the API
 *  takes day/week/month/year, not an exact date). The 30-day default -> "month".
 *  Older than ~1 year -> unrestricted. */
function timeRange(publishedAfter?: string): "day" | "week" | "month" | "year" | undefined {
  if (!publishedAfter || !/^\d{4}-\d{2}-\d{2}$/.test(publishedAfter)) return undefined;
  const days = Math.round((Date.now() - Date.parse(`${publishedAfter}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return undefined;
}

export type TavilyImage = { imageUrl: string; title: string; sourceUrl?: string };

/**
 * Image search through Tavily (`include_images` + descriptions). Used by the
 * Office assistants' image_search tool. Returns [] when Tavily is not configured
 * or on any error; callers report "no results" vs "not configured" themselves.
 */
export async function tavilyImageSearch(
  query: string,
  maxResults = 8,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<TavilyImage[]> {
  const key = process.env["TAVILY_API_KEY"]?.trim();
  const q = (query || "").trim().slice(0, 400);
  if (!key || !q) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        max_results: Math.max(1, Math.min(Math.floor(maxResults || 8), 20)),
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as {
      images?: Array<string | { url?: string; description?: string }>;
      results?: Array<{ url?: string }>;
    };
    const out: TavilyImage[] = [];
    const seen = new Set<string>();
    for (const im of data.images ?? []) {
      const url = typeof im === "string" ? im : im?.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        imageUrl: url,
        title: typeof im === "object" && im && typeof im.description === "string" ? im.description.slice(0, 200) : "",
      });
      if (out.length >= Math.max(1, Math.min(Math.floor(maxResults || 8), 20))) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Search Tavily. Returns [] on ANY error (never throws) so it can never break the
 *  parallel merge — AgentCore + Brave still answer. */
export async function tavilySearch(
  query: string,
  maxResults = 10,
  opts?: { signal?: AbortSignal; timeoutMs?: number; publishedAfter?: string },
): Promise<GatewayResult[]> {
  const key = process.env["TAVILY_API_KEY"]?.trim();
  const q = (query || "").trim().slice(0, 400);
  if (!key || !q) return [];

  const body: Record<string, unknown> = {
    query: q,
    max_results: Math.max(1, Math.min(Math.floor(maxResults || 10), 20)),
    search_depth: "basic", // fast; the local reranker + fetch_page do the deep work
    include_answer: false,
    include_raw_content: false,
  };
  const tr = timeRange(opts?.publishedAfter);
  if (tr) body["time_range"] = tr;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 12_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    const out: GatewayResult[] = [];
    for (const r of data.results ?? []) {
      if (!r || typeof r.url !== "string") continue;
      out.push({
        title: typeof r.title === "string" ? r.title : undefined,
        url: r.url,
        text: typeof r.content === "string" ? r.content : "",
        published: typeof r.published_date === "string" ? r.published_date : undefined,
      });
    }
    return out;
  } catch {
    return []; // never break the merge
  } finally {
    clearTimeout(timer);
  }
}
