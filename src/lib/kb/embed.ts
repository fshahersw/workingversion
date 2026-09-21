// Turn chunker output into embeddable KB rows: build a deterministic context
// prefix, embed (Titan v2) with bounded concurrency + retry, and preserve order.
// The Titan call is injectable so this is unit-testable without Bedrock.

import type { KbChunkInput } from "./chunk.ts";
import type { KbChunkRow } from "./aurora.server.ts";

type EmbedFn = (text: string, signal?: AbortSignal) => Promise<number[] | null>;

// Lazy so the module (and its unit tests) don't resolve the @/ alias or load
// Bedrock at import time; only the default path pulls Titan in, at call time.
const defaultEmbed: EmbedFn = async (text, signal) => {
  const { embedText } = await import("@/lib/pile/titan.server");
  return embedText(text, signal);
};

/** Deterministic contextual-retrieval prefix (doc + section + page). Cheap and
 *  free; a model-generated one can replace it later without schema change. */
export function contextualize(fileName: string, chunk: KbChunkInput): string {
  const bits = [fileName.trim()];
  if (chunk.headingPath) bits.push(chunk.headingPath.trim());
  if (chunk.pageStart) bits.push(`p. ${chunk.pageStart}`);
  return bits.filter(Boolean).join(" — ");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === tries - 1) break;
      // Exponential backoff with FULL JITTER (capped): under 20-30 concurrent
      // saves, Titan throttles in bursts. Jitter stops every retrying embed
      // from resyncing (thundering herd) and lets a document ride out the
      // throttle instead of failing -> poisoning the whole workspace -> Ask
      // silently dropping to full-scan. Total worst-case wait stays < ~10s.
      const ceiling = Math.min(baseMs * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * ceiling) + baseMs));
    }
  }
  throw lastErr;
}

export type EmbedOptions = {
  /** Injectable embedder (defaults to Titan v2 embedText). */
  embed?: EmbedFn;
  concurrency?: number;
  signal?: AbortSignal;
};

/**
 * Embed each chunk (context prefix + content) and return insert-ready rows.
 * Embedding is stored on the row; `context` is persisted separately so the
 * displayed/quoted text stays verbatim. Order is preserved.
 */
export async function embedChunks(
  fileName: string,
  chunks: KbChunkInput[],
  opts: EmbedOptions = {},
): Promise<KbChunkRow[]> {
  const embed = opts.embed ?? defaultEmbed;
  const concurrency = opts.concurrency ?? 6;
  return mapLimit(chunks, concurrency, async (c) => {
    const context = contextualize(fileName, c);
    const input = `${context}\n\n${c.content}`;
    const embedding = await withRetry(() => embed(input, opts.signal));
    return {
      chunkIndex: c.chunkIndex,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      kind: c.kind,
      content: c.content,
      context,
      conf: null,
      tokenCount: c.tokenCount,
      embedding,
    };
  });
}
