// ============================================================================
// Brave Search API client (server-only).
//
// A SECOND web source merged IN PARALLEL with AgentCore for the RESEARCH agent
// only (never the writer/Drafts path — that calls executeTool without the brave
// flag, so its behavior is unchanged). Enabled only when BRAVE_API_KEY is set;
// absent -> braveConfigured() === false and nothing runs, so unset environments
// are byte-for-byte unaffected.
//
// Results are mapped to the SAME shape agentCoreSearch returns (GatewayResult),
// so the existing rankResults + EXCLUDED_DOMAINS + dedupe pipeline filters Brave's
// broad output — Brave surfaces the lead-gen / aggregator hosts the ranker already
// drops, so it MUST pass through that ranker before reaching the model.
//
// Docs: https://api.search.brave.com/app/documentation/web-search/get-started
// ============================================================================
import type { GatewayResult } from "./agentcore-search.server";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** True only when a Brave key is configured. Off by default. */
export function braveConfigured(): boolean {
  return !!process.env["BRAVE_API_KEY"]?.trim();
}

/** YYYY-MM-DD (UTC) for Brave's freshness date range. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Search Brave's independent web index. Returns [] on any error or when no key
 *  is set — a Brave outage NEVER breaks the merge; AgentCore still answers. */
export async function braveSearch(
  query: string,
  maxResults = 10,
  opts?: { signal?: AbortSignal; timeoutMs?: number; publishedAfter?: string },
): Promise<GatewayResult[]> {
  const key = process.env["BRAVE_API_KEY"]?.trim();
  const q = (query || "").trim().slice(0, 400);
  if (!key || !q) return [];

  const params = new URLSearchParams({
    q,
    count: String(Math.max(1, Math.min(Math.floor(maxResults || 10), 20))),
    text_decorations: "false",
    spellcheck: "false",
  });
  // Recency: map a YYYY-MM-DD lower bound to a Brave freshness date range so Brave
  // honors the same 30-day-default / published_after window AgentCore uses.
  if (opts?.publishedAfter && /^\d{4}-\d{2}-\d{2}$/.test(opts.publishedAfter)) {
    params.set("freshness", `${opts.publishedAfter}to${ymd(new Date())}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 12_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  try {
    const res = await fetch(`${BRAVE_ENDPOINT}?${params.toString()}`, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          page_age?: string;
          age?: string;
        }>;
      };
    };
    const rows = data.web?.results ?? [];
    const out: GatewayResult[] = [];
    for (const r of rows) {
      if (!r || typeof r.url !== "string") continue;
      out.push({
        title: typeof r.title === "string" ? r.title : undefined,
        url: r.url,
        text: typeof r.description === "string" ? r.description : "",
        // page_age is an ISO timestamp; age is a relative string. Prefer the ISO.
        published:
          typeof r.page_age === "string"
            ? r.page_age
            : typeof r.age === "string"
              ? r.age
              : undefined,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
