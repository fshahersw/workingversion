// ============================================================================
// Semantic rerank for web-search candidates (server-only).
//
// The lexical ranker in web-rank.ts scores term overlap; a 3-4 word search
// query often misses the on-point passage whose wording differs ("Rule 702
// ruling" vs "excluded the plaintiffs' general-causation experts"). This stage
// embeds the query and each candidate's evidence snippet with Titan Text
// Embeddings v2 (already in-account for the KB) and returns a semantic
// ordering that categorySearch fuses with the lexical one via RRF.
//
// It must never slow a search down or break it:
//   - hard wall-clock cap (default 1.5s): whatever has embedded by then is used,
//     the rest fall back to their lexical rank alone (the caller feeds
//     candidates best-lexical-first, so the cap trims the weakest, and fuses
//     only when enough of the pool was scored);
//   - bounded concurrency so a 15-candidate pool does not burst Bedrock;
//   - the query embedding is memoized through the run-scoped tool cache, so
//     the 1-4 categories of one web_search and its stale retry embed it once;
//   - circuit breaker: on an access/validation error (model not enabled) the
//     stage disables itself for a cooldown so every later search pays nothing;
//   - WEB_RERANK=off disables it entirely.
// ============================================================================
import { embedTextStrict, TitanEmbedError } from "@/lib/pile/titan.server";
import { memoTTL, toolCacheKey, TOOL_CACHE_TTL_MS } from "./run-state.server";
import { semanticOrder } from "./web-rank";

const CAP_MS = Number(process.env["WEB_RERANK_CAP_MS"]) || 1_500;
const CONCURRENCY = 6;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
const MAX_CANDIDATES = 18;
/** Evidence snippets are short; cap the embed input so latency stays flat. */
const MAX_CHARS = 1_200;

let breakerUntil = 0;

export function webRerankEnabled(): boolean {
  const flag = (process.env["WEB_RERANK"] ?? "embed").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return Date.now() >= breakerUntil;
}

/** Test seam: reset the breaker between cases. */
export function resetWebRerankBreaker(): void {
  breakerUntil = 0;
}

async function embedCapped(text: string, signal: AbortSignal): Promise<number[] | null> {
  try {
    return await embedTextStrict(text.slice(0, MAX_CHARS), signal);
  } catch (err) {
    // Our own cap aborting the fetch is not an error; everything else propagates
    // so the caller can decide whether to trip the breaker.
    if (signal.aborted) return null;
    throw err;
  }
}

/** Raised inside the memoized compute when the query embedding was capped or
 *  aborted: memoTTL caches any returned value, and a cached null would silence
 *  the stage for the whole TTL, so the miss is thrown past the cache instead
 *  (a compute failure is never cached) and every waiter fails open. */
class QueryEmbedUnavailable extends Error {
  constructor() {
    super("query embedding unavailable");
    this.name = "QueryEmbedUnavailable";
  }
}

/**
 * Query vector, memoized through the run-scoped tool cache: the 1-4 categories
 * of one web_search fan out in parallel and the stale retry re-runs the same
 * query, so one embed serves them all (concurrent callers share the in-flight
 * compute). Null when capped/aborted before it embedded; other errors
 * propagate so the caller can decide whether to trip the breaker.
 */
async function queryVector(query: string, signal: AbortSignal): Promise<number[] | null> {
  try {
    return await memoTTL(toolCacheKey("embed_query", { text: query }), TOOL_CACHE_TTL_MS, async () => {
      const v = await embedCapped(query, signal);
      if (!v) throw new QueryEmbedUnavailable();
      return v;
    });
  } catch (err) {
    if (err instanceof QueryEmbedUnavailable) return null;
    throw err;
  }
}

/**
 * Semantic order of candidate keys for `query`. Returns [] when the stage is
 * off, tripped, capped before the query embedded, or fails for any reason, so
 * the caller's fusion degrades to the lexical order. Never throws.
 */
export async function semanticRerank(
  query: string,
  candidates: { key: string; text: string }[],
  opts?: { signal?: AbortSignal; capMs?: number },
): Promise<string[]> {
  if (!webRerankEnabled() || !query.trim() || candidates.length < 2) return [];
  const pool = candidates.slice(0, MAX_CANDIDATES).filter((c) => c.text.trim().length > 0);
  if (pool.length < 2) return [];

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const cap = setTimeout(() => controller.abort(), opts?.capMs ?? CAP_MS);

  try {
    // The query embedding gates everything: without it nothing can be scored.
    const queryVec = await queryVector(query, controller.signal);
    if (!queryVec) return [];

    const vectors = new Map<string, number[]>();
    let next = 0;
    const worker = async () => {
      while (next < pool.length && !controller.signal.aborted) {
        const c = pool[next++]!;
        const v = await embedCapped(c.text, controller.signal);
        if (v) vectors.set(c.key, v);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pool.length) }, worker));
    // Below two scored candidates a semantic order carries no information.
    if (vectors.size < 2) return [];
    return semanticOrder(queryVec, vectors);
  } catch (err) {
    // One worker failed: stop the others (their in-flight embeds abort and
    // their loops exit) instead of letting them keep paying for a result that
    // is already being discarded.
    controller.abort();
    // Model not enabled / access denied / bad request: a permanent condition for
    // this deployment, so stop trying for a while. Throttles and 5xx are
    // transient: skip this search only.
    if (err instanceof TitanEmbedError && (err.status === 400 || err.status === 403 || err.status === 404)) {
      breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
    return [];
  } finally {
    clearTimeout(cap);
    opts?.signal?.removeEventListener("abort", onOuterAbort);
  }
}
