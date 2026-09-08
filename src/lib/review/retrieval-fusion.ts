// ============================================================================
// Tabular Review — pure retrieval fusion.
//
// Two rankers pick evidence pages for one (document, question) pair: the
// in-tab BM25 index (fast, lexical, includes ±1 neighbours) and the saved KB
// index (pgvector + BM25, semantic). Reciprocal-rank fusion merges them so a
// page either ranker is confident about makes the pack, then the pack is
// read in document order. No network, no React, no `@/` imports.
// ============================================================================

const RRF_K = 60;

/**
 * Fuse two page rankings. Ties break toward the lexical ranking, then the
 * lower page number. The result is capped and sorted ascending so the model
 * reads the document in order.
 */
export function fusePageRanks(
  lexical: readonly number[],
  semantic: readonly number[],
  cap: number,
): number[] {
  const score = new Map<number, number>();
  const lexRank = new Map<number, number>();
  lexical.forEach((page, i) => {
    if (!lexRank.has(page)) lexRank.set(page, i);
    score.set(page, (score.get(page) ?? 0) + 1 / (RRF_K + i));
  });
  semantic.forEach((page, i) => {
    score.set(page, (score.get(page) ?? 0) + 1 / (RRF_K + i));
  });
  return [...score.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (lexRank.get(a[0]) ?? Number.MAX_SAFE_INTEGER) -
          (lexRank.get(b[0]) ?? Number.MAX_SAFE_INTEGER) ||
        a[0] - b[0],
    )
    .slice(0, Math.max(1, cap))
    .map(([page]) => page)
    .sort((a, b) => a - b);
}

/**
 * Add the page before and after each chosen page (when it exists) without
 * exceeding the cap: a clause that starts at the bottom of one page finishes
 * on the next. Chosen pages always survive; neighbours fill remaining room.
 */
export function withNeighbours(pages: readonly number[], pageCount: number, cap: number): number[] {
  const chosen = new Set(pages);
  const out = new Set(pages);
  for (const page of pages) {
    for (const neighbour of [page - 1, page + 1]) {
      if (out.size >= cap) break;
      if (neighbour < 1 || neighbour > pageCount || chosen.has(neighbour)) continue;
      out.add(neighbour);
    }
  }
  return [...out].sort((a, b) => a - b);
}
