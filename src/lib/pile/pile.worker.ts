/// <reference lib="webworker" />
import { PileIndex } from "./pile-index.ts";
import type { PileHit, PilePage, PileStructure } from "./types.ts";

export type PileWorkerRequest =
  | { id: number; op: "clear" }
  | { id: number; op: "addPages"; pages: PilePage[] }
  | { id: number; op: "updatePageText"; fileId: string; page: number; text: string }
  | { id: number; op: "search"; query: string; k: number; structure: PileStructure | null }
  | { id: number; op: "packAsk"; query: string; structure: PileStructure | null }
  | { id: number; op: "searchByFile"; query: string; perFileK: number; structure: PileStructure | null }
  | { id: number; op: "packAskByFile"; query: string; structure: PileStructure | null; perFileCap?: number }
  | { id: number; op: "textsFor"; hits: { fileId: string; page: number }[] }
  | { id: number; op: "structureSample"; maxPerFile: number };

export type PileWorkerResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const pile = new PileIndex();

export function handlePileRequest(req: PileWorkerRequest): unknown {
  switch (req.op) {
    case "clear":
      pile.clear();
      return { size: 0 };
    case "addPages":
      pile.addPages(req.pages);
      return { size: pile.size };
    case "updatePageText":
      return { changed: pile.updatePageText(req.fileId, req.page, req.text) };
    case "search": {
      const hits: PileHit[] = pile.search(req.query, req.k, req.structure);
      return { hits, texts: pile.textsFor(hits) };
    }
    case "packAsk": {
      const packed = pile.packAsk(req.query, req.structure);
      return { hits: packed.hits, pages: packed.pages, texts: pile.textsFor(packed.hits) };
    }
    case "searchByFile": {
      const groups = pile.searchByFile(req.query, req.perFileK, req.structure);
      return { groups, texts: pile.textsFor(groups.flatMap((g) => g.hits)) };
    }
    case "packAskByFile": {
      const groups = pile.packAskByFile(req.query, req.structure, undefined, req.perFileCap);
      return { groups, texts: pile.textsFor(groups.flatMap((g) => g.hits)) };
    }
    case "textsFor":
      return { texts: pile.textsFor(req.hits) };
    case "structureSample":
      return { pages: pile.structureSample(req.maxPerFile) };
    default:
      throw new Error("unknown pile op");
  }
}

self.addEventListener("message", (event: MessageEvent<PileWorkerRequest>) => {
  const req = event.data;
  try {
    const result = handlePileRequest(req);
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, result } as PileWorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : "pile worker failed",
    } as PileWorkerResponse);
  }
});
