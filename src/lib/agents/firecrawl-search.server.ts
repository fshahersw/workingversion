// ============================================================================
// Firecrawl news search (server-only).
//
// Second backend for the research landing's "Since you were here" headlines,
// alongside Tavily. Key from FIRECRAWL_API_KEY; absent -> disabled
// (firecrawlConfigured() === false). Returns [] on ANY error and never throws,
// so a Firecrawl outage can never blank the landing page.
//
// v2 /search with sources:["news"]. Firecrawl's `tbs` time filter applies to
// web results only, so recency is enforced downstream from each item's date
// (research-brief.ts mergeHeadlineCandidates); undated items are kept.
// ============================================================================
import type { HeadlineCandidate } from "../research-brief";

const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";

export function firecrawlConfigured(): boolean {
  return !!process.env["FIRECRAWL_API_KEY"]?.trim();
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const RELATIVE_RE = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i;
const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** ISO timestamp from an absolute or relative ("3 days ago") date string. */
export function toIsoDate(raw: string, now = Date.now()): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const abs = Date.parse(s);
  if (!Number.isNaN(abs)) return new Date(abs).toISOString();
  const m = s.match(RELATIVE_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms = UNIT_MS[unit];
  if (!Number.isFinite(n) || !ms) return undefined;
  return new Date(now - n * ms).toISOString();
}

/**
 * Pure parser for a v2 /search response. Tolerant of the field names Firecrawl
 * has used across releases (snippet|description, date|publishedDate, imageUrl|image)
 * and of `data` being the news array itself. Exported for tests.
 */
export function parseFirecrawlNews(json: unknown, max = 10, now = Date.now()): HeadlineCandidate[] {
  const root = (json ?? {}) as { success?: unknown; data?: unknown };
  if (root.success === false || !root.data || typeof root.data !== "object") return [];
  const data = root.data as { news?: unknown } | unknown[];
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { news?: unknown }).news)
      ? (data as { news: unknown[] }).news
      : [];
  const out: HeadlineCandidate[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = str(r["url"]);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = str(r["title"]);
    if (!title) continue;
    const snippet = str(r["snippet"]) || str(r["description"]);
    const published = toIsoDate(str(r["date"]) || str(r["publishedDate"]) || str(r["published_date"]), now);
    const image = str(r["imageUrl"]) || str(r["image"]);
    out.push({
      backend: "firecrawl",
      rank: out.length + 1,
      title: title.slice(0, 220),
      url,
      snippet: snippet.slice(0, 280),
      ...(published ? { published } : {}),
      ...(image && /^https:\/\//i.test(image) ? { imageUrl: image } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

export async function firecrawlNewsSearch(
  query: string,
  opts?: { maxResults?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<HeadlineCandidate[]> {
  const key = process.env["FIRECRAWL_API_KEY"]?.trim();
  const q = (query || "").trim().slice(0, 400);
  if (!key || !q) return [];
  const limit = Math.max(1, Math.min(Math.floor(opts?.maxResults || 5), 10));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8_000);
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(FIRECRAWL_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q, sources: ["news"], limit }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json: unknown = await res.json().catch(() => null);
    return parseFirecrawlNews(json, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}
