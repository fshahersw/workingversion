import { join } from "node:path";

import { openPileStore, type PileStore } from "./store";

let store: PileStore | undefined;

export function pileStore(): PileStore {
  if (!store) store = openPileStore(join(process.cwd(), ".data", "pile.sqlite"));
  return store;
}

export function remainingTtl(expiresAt: number): number {
  return Math.max(1, expiresAt - Date.now());
}
