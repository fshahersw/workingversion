import { mapPool } from "./async";
import { rerankPileHits } from "./rerank.server";
import { cosine, embedText } from "./titan.server";
import type { PileHit, PileStructure } from "./types";

/**
 * BM25 candidates in, hybrid rank out: Titan cosine on snippets, then an
 * LLM rerank. Either stage can fail closed to the original order.
 */
export async function hybridRerankHits(
  query: string,
  hits: PileHit[],
  k: number,
  structure: PileStructure | null,
  signal?: AbortSignal,
): Promise<PileHit[]> {
  if (hits.length <= 1) return hits.slice(0, k);
  const pool = hits.slice(0, Math.min(32, hits.length));
  let ordered = pool;
  try {
    const qv = await embedText(query, signal);
    if (qv) {
      const scored = await mapPool(
        pool,
        6,
        async (h) => {
          const ev = await embedText((h.snippet || "").slice(0, 2000), signal);
          return { h, cos: ev ? cosine(qv, ev) : 0 };
        },
        signal,
      );
      const rrf = new Map<string, number>();
      const add = (key: string, rank: number) =>
        rrf.set(key, (rrf.get(key) ?? 0) + 1 / (60 + rank));
      pool.forEach((h, i) => add(`${h.fileId}:${h.page}`, i));
      [...scored]
        .sort((a, b) => b.cos - a.cos)
        .forEach((row, i) => add(`${row.h.fileId}:${row.h.page}`, i));
      const byId = new Map(pool.map((h) => [`${h.fileId}:${h.page}`, h]));
      ordered = [...rrf.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => byId.get(key)!)
        .filter(Boolean);
    }
  } catch {
    ordered = pool;
  }
  return rerankPileHits(query, structure, ordered, k, signal);
}
