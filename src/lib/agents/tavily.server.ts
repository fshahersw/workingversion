// ============================================================================
// Tavily research engine (server-only, experimental).
//
// Behind RESEARCH_ENGINE=tavily this replaces the seven AgentCore gateways AND
// the DocketBird tool loop: the router still classifies effort and names the
// research angles, but each angle becomes ONE Tavily advanced search with an
// included answer instead of a sub-agent model turn with tool calls.
//
// Trade-off (deliberate, flag-gated): no docket sheet, filing text, calendar or
// relationship graph on this path — only the open web, ranked by Tavily plus
// the local tier/recency scoring in web-rank.ts.
// ============================================================================
import type { Source } from "@/lib/chat-types";

import { agentError, agentLog, since, trunc } from "./log.server";
import { memoTTL, toolCacheKey, TOOL_CACHE_TTL_MS } from "./run-state.server";
import { SourceBook } from "./tools.server";
import {
  allStale,
  EXCLUDED_DOMAINS,
  isExcludedHost,
  normalizeUrl,
  rankResults,
  tierOf,
  wantsRecency,
  type RankableResult,
} from "./web-rank";

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 20_000;
/** Over-fetch, then keep the best few after the local rerank. */
const CANDIDATE_POOL = 12;
const KEEP_DEFAULT = 5;
/** Drop provider hits scored below this — recent-but-unrelated noise. */
const RELEVANCE_FLOOR = 0.2;

export type TavilyTimeRange = "day" | "week" | "month" | "year";

export type TavilyHit = RankableResult & {
  favicon?: string;
  score?: number;
};

export type TavilyResponse = {
  answer: string;
  results: TavilyHit[];
};

export function tavilyConfigured(): boolean {
  return !!process.env["TAVILY_API_KEY"];
}

/** True when the flag routes research through Tavily instead of AgentCore. */
export function tavilyEngineEnabled(): boolean {
  const engine = (process.env["RESEARCH_ENGINE"] || "").trim().toLowerCase();
  return engine === "tavily" && tavilyConfigured();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Tavily advanced search with the answer included. Bounded retry on
 *  429/5xx; every other status surfaces as a real error. */
export async function tavilySearch(opts: {
  query: string;
  maxResults?: number;
  timeRange?: TavilyTimeRange;
  topic?: "general" | "news";
  signal?: AbortSignal;
}): Promise<TavilyResponse> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key) throw new Error("TAVILY_API_KEY is not configured.");

  const body = JSON.stringify({
    query: opts.query,
    topic: opts.topic ?? "general",
    search_depth: "advanced",
    include_answer: "advanced",
    include_raw_content: false,
    include_images: false,
    include_favicon: true,
    max_results: opts.maxResults ?? CANDIDATE_POOL,
    ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
    exclude_domains: EXCLUDED_DOMAINS,
    language: "en",
  });

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `tavily ${res.status} ${trunc(await res.text(), 160)}`;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`tavily ${res.status} ${trunc(await res.text(), 200)}`);
      const json = (await res.json()) as {
        answer?: unknown;
        results?: Array<Record<string, unknown>>;
      };
      const results: TavilyHit[] = (json.results ?? [])
        .map((r) => ({
          title: typeof r["title"] === "string" ? r["title"] : "",
          url: typeof r["url"] === "string" ? r["url"] : "",
          text: typeof r["content"] === "string" ? r["content"] : "",
          published:
            typeof r["published_date"] === "string" ? (r["published_date"] as string) : undefined,
          favicon: typeof r["favicon"] === "string" ? (r["favicon"] as string) : undefined,
          score: typeof r["score"] === "number" ? (r["score"] as number) : undefined,
        }))
        .filter((r) => !!r.url && !!r.text && !isExcludedHost(r.url));
      return {
        answer: typeof json.answer === "string" ? json.answer.trim() : "",
        results,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "tavily request failed";
      if (opts.signal?.aborted) throw err;
      if (attempt === 2) break;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(lastErr || "tavily request failed");
}

/** Recency intent → Tavily time_range. Undefined means "no window". */
export function timeRangeFor(text: string): TavilyTimeRange | undefined {
  const t = text.toLowerCase();
  if (/\b(today|yesterday|this week|past week|last few days|breaking)\b/.test(t)) return "week";
  if (/\b(this month|past month|last month|recent|latest|current|newest|just filed|now)\b/.test(t))
    return "month";
  if (wantsRecency(text)) return "year";
  return undefined;
}

/** News-shaped angles get Tavily's news topic (dated, press-weighted index). */
export function topicFor(text: string): "general" | "news" {
  return /\b(news|coverage|headline|press|reported|settlement talks|announced|verdict)\b/i.test(text)
    ? "news"
    : "general";
}

const SOURCE_TYPE_BY_TIER: Record<1 | 2 | 3, string> = {
  1: "case_law",
  2: "regulation",
  3: "news",
};

export type TavilyAngleResult = {
  focus: string;
  answer: string;
  /** Evidence block for the writer / router transcript, with [S#] refs. */
  digest: string;
  refs: string[];
  hits: number;
  failed?: boolean;
};

/**
 * Run ONE research angle: a single Tavily call, locally reranked, registered in
 * the SourceBook so the panel and citations behave exactly as on the old path.
 */
export async function runTavilyAngle(opts: {
  focus: string;
  question: string;
  book: SourceBook;
  seen: Set<string>;
  keep?: number;
  signal?: AbortSignal;
  runId?: string;
}): Promise<TavilyAngleResult> {
  const query = opts.focus.replace(/\s+/g, " ").trim().slice(0, 380);
  const recencyText = `${opts.focus} ${opts.question}`;
  const timeRange = timeRangeFor(recencyText);
  const topic = topicFor(opts.focus);
  const keep = opts.keep ?? KEEP_DEFAULT;
  const start = Date.now();

  const call = (tr: TavilyTimeRange | undefined, tp: "general" | "news" = topic) =>
    memoTTL(
      toolCacheKey("tavily", { query, topic: tp, tr: tr ?? "-", limit: CANDIDATE_POOL }),
      TOOL_CACHE_TTL_MS,
      () =>
        tavilySearch({
          query,
          topic: tp,
          maxResults: CANDIDATE_POOL,
          ...(tr ? { timeRange: tr } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
    );

  /** Provider relevance floor: a narrow window can return dated-but-unrelated
   *  pages with scores around 0.05. Those are noise, not evidence. */
  const onTopic = (r: TavilyResponse) => ({
    ...r,
    results: r.results.filter((h) => typeof h.score !== "number" || h.score >= RELEVANCE_FLOOR),
  });

  let res: TavilyResponse;
  try {
    res = onTopic(await call(timeRange));
  } catch (err) {
    const msg = trunc(err instanceof Error ? err.message : "search failed", 200);
    agentError("tavily_failed", { run: opts.runId, focus: trunc(query, 120), error: msg });
    return { focus: opts.focus, answer: "", digest: `Tavily search failed: ${msg}`, refs: [], hits: 0, failed: true };
  }

  const rank = (r: TavilyResponse, recency: boolean) =>
    rankResults(r.results, { query, keep, recency, seen: opts.seen, perDomain: 2 }).slice(0, keep);

  const recency = Boolean(timeRange);
  let ranked = rank(res, recency);

  // Broadening retry: a windowed or news-topic search that came back with
  // nothing on topic gets one unwindowed general pass rather than feeding the
  // writer irrelevant-but-recent pages.
  if (!ranked.length && (timeRange || topic === "news")) {
    try {
      const wide = onTopic(await call(undefined, "general"));
      const reranked = rank(wide, recency);
      if (reranked.length) {
        ranked = reranked;
        res = wide;
        agentLog("tavily_broaden", { run: opts.runId, focus: trunc(query, 100) });
      }
    } catch {
      /* keep the first pass */
    }
  }

  // Recency question that came back all-stale: one tightened retry in a window.
  if (recency && ranked.length && allStale(ranked) && timeRange !== "month") {
    try {
      const retry = onTopic(await call("month"));
      const reranked = rank(retry, true);
      if (reranked.length) {
        ranked = reranked;
        if (retry.answer) res = { ...res, answer: retry.answer };
        agentLog("tavily_retry", { run: opts.runId, focus: trunc(query, 100) });
      }
    } catch {
      /* keep the first pass */
    }
  }


  const refs: string[] = [];
  const lines = ranked.map((r) => {
    const hit = r.result;
    const tier = tierOf(hit.url, undefined);
    const src: Omit<Source, "ref"> = {
      citation: hit.title?.trim() || hit.url || "Web source",
      authority: "web",
      source_type: SOURCE_TYPE_BY_TIER[tier],
      content: hit.text,
      ...(hit.url ? { source_url: hit.url } : {}),
      ...(r.date ? { effective_date: r.date } : {}),
      ...(hit.favicon ? { favicon: hit.favicon } : {}),
      ...(typeof hit.score === "number" ? { relevance: hit.score } : {}),
    };
    const registered = opts.book.add(src);
    refs.push(registered.ref);
    opts.seen.add(normalizeUrl(hit.url));
    return `[${registered.ref}] ${registered.citation}${hit.url ? ` — ${hit.url}` : ""}\n${
      r.date ? `dated ${r.date}` : "date: unknown"
    }\n${r.evidence || trunc(hit.text, 450)}`;
  });

  agentLog("tavily_angle", {
    run: opts.runId,
    ms: since(start),
    focus: trunc(query, 120),
    topic,
    time_range: timeRange ?? "-",
    candidates: res.results.length,
    kept: ranked.length,
    answer_chars: res.answer.length,
  });

  const digest = [
    res.answer ? `TAVILY ANSWER (grounded summary — verify against the sources below)\n${res.answer}` : "",
    lines.length ? `SOURCES\n${lines.join("\n\n")}` : "No usable web results for this angle.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { focus: opts.focus, answer: res.answer, digest, refs, hits: ranked.length };
}
