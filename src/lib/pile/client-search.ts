import { PileIndex, pageToHit } from "./pile-index.ts";
import { ASK_CANDIDATES, ASK_PACK } from "./limits.ts";
import type { PileHit, PilePage, PileStructure } from "./types.ts";

export { pageToHit };

function indexOf(pages: PilePage[]): PileIndex {
  const pile = new PileIndex();
  pile.addPages(pages);
  return pile;
}

/** One-shot helpers kept for callers that hold a plain page array (tests, server). */
export function searchPages(
  pages: PilePage[],
  query: string,
  k = 12,
  structure?: PileStructure | null,
): PileHit[] {
  return indexOf(pages).search(query, k, structure);
}

export function coverPages(pages: PilePage[], k: number): PileHit[] {
  return indexOf(pages).cover(k);
}

export function packAskHits(
  pages: PilePage[],
  query: string,
  k = ASK_CANDIDATES,
  cap = ASK_PACK,
): PileHit[] {
  return indexOf(pages).packAsk(query, null, k, cap).hits;
}

export function pagesForClientHits(pages: PilePage[], hits: PileHit[]): PilePage[] {
  const byId = new Map(pages.map((p) => [`${p.fileId}:${p.page}`, p]));
  return hits.map((h) => byId.get(`${h.fileId}:${h.page}`)).filter((p): p is PilePage => !!p);
}
