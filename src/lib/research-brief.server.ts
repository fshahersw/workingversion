/**
 * Personalized landing headlines. Reads the caller's recent conversation
 * titles, searches the configured news backends (Tavily and/or Firecrawl) in
 * parallel, merges them per topic, caches for six hours. Never throws.
 * Disabled with RESEARCH_BRIEF=off. Does not call Bedrock.
 */
import { createHash } from "node:crypto";

import { firecrawlConfigured, firecrawlNewsSearch } from "./agents/firecrawl-search.server.ts";
import { isExcludedHost } from "./agents/web-rank.ts";
import { tavilyConfigured, tavilyNewsSearch, type TavilyNewsItem } from "./agents/tavily-search.server.ts";
import { listConversations } from "./chat/chat.server.ts";
import {
  briefEnabled,
  headlinePrompt,
  headlineWhy,
  hostOfUrl,
  mergeHeadlineCandidates,
  selectHeadlines,
  topicsFromTitles,
  type HeadlineCandidate,
  type ResearchHeadline,
} from "./research-brief.ts";
import { enrichQuestions, verifyImages } from "./research-brief-enrich.server.ts";

const CACHE_MS = 6 * 60 * 60 * 1000;
/** An empty result is usually a slow backend, not "no news": caching it for six
 *  hours would blank the section for the rest of the day, so retry sooner. */
const EMPTY_CACHE_MS = 10 * 60 * 1000;
const BACKEND_TIMEOUT_MS = 7_000;
const cache = new Map<string, { at: number; key: string; items: ResearchHeadline[] }>();

function excluded(url: string): boolean {
  return isExcludedHost(url);
}

function fromTavily(items: TavilyNewsItem[]): HeadlineCandidate[] {
  return items.map((it, i) => ({
    backend: "tavily" as const,
    rank: i + 1,
    title: it.title,
    url: it.url,
    snippet: it.snippet,
    ...(it.published ? { published: it.published } : {}),
    ...(it.imageUrl ? { imageUrl: it.imageUrl } : {}),
  }));
}

/** Both backends for one topic, in parallel; either may be unconfigured or fail. */
async function searchTopic(topic: string): Promise<HeadlineCandidate[]> {
  const query = `${topic} litigation court ruling`;
  const [tavily, firecrawl] = await Promise.all([
    tavilyConfigured()
      ? tavilyNewsSearch(query, { maxResults: 4, timeoutMs: BACKEND_TIMEOUT_MS, timeRange: "week" })
      : Promise.resolve([] as TavilyNewsItem[]),
    firecrawlConfigured()
      ? firecrawlNewsSearch(query, { maxResults: 4, timeoutMs: BACKEND_TIMEOUT_MS })
      : Promise.resolve([] as HeadlineCandidate[]),
  ]);
  return mergeHeadlineCandidates([fromTavily(tavily), firecrawl]);
}

export function headlineBackendsConfigured(): boolean {
  return tavilyConfigured() || firecrawlConfigured();
}

export async function loadResearchBrief(principal: string): Promise<ResearchHeadline[]> {
  if (!briefEnabled() || !headlineBackendsConfigured() || !principal) return [];
  try {
    const convos = await listConversations(principal, 16);
    const topics = topicsFromTitles(convos.map((c) => c.title), 3);
    if (!topics.length) return [];
    const key = createHash("sha256").update(topics.join("|")).digest("hex").slice(0, 16);
    const hit = cache.get(principal);
    const ttl = hit && hit.items.length === 0 ? EMPTY_CACHE_MS : CACHE_MS;
    if (hit && hit.key === key && Date.now() - hit.at < ttl) return hit.items;

    const batches = await Promise.all(
      topics.map(async (topic) => ({ topic, items: await searchTopic(topic) })),
    );

    const seen = new Set<string>();
    const out: ResearchHeadline[] = [];
    for (const batch of batches) {
      // Relevance to the topic first (a news API returns unrelated stories for a
      // narrow query), then a small nudge for courts and the trade press.
      const ranked = selectHeadlines(
        batch.topic,
        batch.items.filter((it) => !excluded(it.url) && !seen.has(it.url)),
        2,
      );
      for (const it of ranked) {
        seen.add(it.url);
        out.push({
          id: `${key}-${out.length + 1}`,
          topic: batch.topic,
          title: it.title,
          url: it.url,
          source: hostOfUrl(it.url),
          snippet: it.snippet,
          why: headlineWhy(batch.topic),
          prompt: headlinePrompt(batch.topic, it.title),
          backend: it.backend,
          ...(it.published ? { published: it.published } : {}),
          ...(it.imageUrl ? { imageUrl: it.imageUrl } : {}),
        });
        if (out.length >= 4) break;
      }
      if (out.length >= 4) break;
    }
    // Enrich once per cached build (never per page render), both fail-safe:
    // sharp per-headline litigator questions + a vision image-quality gate.
    await Promise.all([enrichQuestions(out).catch(() => {}), verifyImages(out).catch(() => {})]);
    cache.set(principal, { at: Date.now(), key, items: out });
    return out;
  } catch {
    return [];
  }
}
