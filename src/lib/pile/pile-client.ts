import { PileIndex } from "./pile-index.ts";
import type { PileFileHits, PileFilePack, PileHit, PilePage, PileStructure } from "./types.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type SearchResult = { hits: PileHit[]; texts: Record<string, string> };
export type AskPack = { hits: PileHit[]; pages: PilePage[]; texts: Record<string, string> };
export type FileSearchResult = { groups: PileFileHits[]; texts: Record<string, string> };
export type FileAskPacks = { groups: PileFilePack[]; texts: Record<string, string> };

/**
 * Thin RPC wrapper around the pile worker. Tokenizing and scoring tens of thousands
 * of pages must not happen on the UI thread; if a worker cannot be created (older
 * browser, SSR, tests) the same index runs in-thread instead.
 */
export class PileClient {
  private worker: Worker | null = null;
  private local: PileIndex | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor() {
    if (typeof Worker !== "undefined" && typeof window !== "undefined") {
      try {
        this.worker = new Worker(new URL("./pile.worker.ts", import.meta.url), { type: "module" });
        this.worker.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as { id: number; ok: boolean; result?: unknown; error?: string };
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? "pile worker failed"));
        });
        this.worker.addEventListener("error", () => this.degrade());
      } catch {
        this.worker = null;
      }
    }
    if (!this.worker) this.local = new PileIndex();
  }

  /** Worker died mid-run — fail pending calls and continue in-thread. */
  private degrade(): void {
    this.worker?.terminate();
    this.worker = null;
    if (!this.local) this.local = new PileIndex();
    for (const [, p] of this.pending) p.reject(new Error("pile worker stopped"));
    this.pending.clear();
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      return Promise.resolve(this.handleLocal(this.local!, payload) as T);
    }
    const id = (this.seq += 1);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, ...payload });
    });
  }

  private handleLocal(pile: PileIndex, payload: Record<string, unknown>): unknown {
    const op = payload["op"];
    if (op === "clear") {
      pile.clear();
      return { size: 0 };
    }
    if (op === "addPages") {
      pile.addPages(payload["pages"] as PilePage[]);
      return { size: pile.size };
    }
    if (op === "updatePageText") {
      return {
        changed: pile.updatePageText(
          payload["fileId"] as string,
          payload["page"] as number,
          payload["text"] as string,
        ),
      };
    }
    if (op === "search") {
      const hits = pile.search(
        payload["query"] as string,
        payload["k"] as number,
        payload["structure"] as PileStructure | null,
      );
      return { hits, texts: pile.textsFor(hits) };
    }
    if (op === "searchByFile") {
      const groups = pile.searchByFile(
        payload["query"] as string,
        payload["perFileK"] as number,
        payload["structure"] as PileStructure | null,
      );
      return { groups, texts: pile.textsFor(groups.flatMap((g) => g.hits)) };
    }
    if (op === "packAskByFile") {
      const groups = pile.packAskByFile(
        payload["query"] as string,
        payload["structure"] as PileStructure | null,
        undefined,
        payload["perFileCap"] as number | undefined,
      );
      return { groups, texts: pile.textsFor(groups.flatMap((g) => g.hits)) };
    }
    if (op === "packAsk") {
      const packed = pile.packAsk(
        payload["query"] as string,
        payload["structure"] as PileStructure | null,
      );
      return { hits: packed.hits, pages: packed.pages, texts: pile.textsFor(packed.hits) };
    }
    if (op === "textsFor") {
      return { texts: pile.textsFor(payload["hits"] as { fileId: string; page: number }[]) };
    }
    if (op === "structureSample") {
      return { pages: pile.structureSample(payload["maxPerFile"] as number) };
    }
    throw new Error("unknown pile op");
  }

  clear(): Promise<{ size: number }> {
    return this.call({ op: "clear" });
  }

  addPages(pages: PilePage[]): Promise<{ size: number }> {
    return this.call({ op: "addPages", pages });
  }

  updatePageText(fileId: string, page: number, text: string): Promise<{ changed: boolean }> {
    return this.call({ op: "updatePageText", fileId, page, text });
  }

  search(query: string, k: number, structure: PileStructure | null): Promise<SearchResult> {
    return this.call({ op: "search", query, k, structure });
  }

  packAsk(query: string, structure: PileStructure | null): Promise<AskPack> {
    return this.call({ op: "packAsk", query, structure });
  }

  searchByFile(
    query: string,
    perFileK: number,
    structure: PileStructure | null,
  ): Promise<FileSearchResult> {
    return this.call({ op: "searchByFile", query, perFileK, structure });
  }

  packAskByFile(
    query: string,
    structure: PileStructure | null,
    perFileCap?: number,
  ): Promise<FileAskPacks> {
    return this.call({ op: "packAskByFile", query, structure, perFileCap });
  }

  textsFor(hits: { fileId: string; page: number }[]): Promise<{ texts: Record<string, string> }> {
    return this.call({ op: "textsFor", hits });
  }

  structureSample(
    maxPerFile = 8,
  ): Promise<{ pages: { fileName: string; page: number; text: string }[] }> {
    return this.call({ op: "structureSample", maxPerFile });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.local = null;
    this.pending.clear();
  }
}
