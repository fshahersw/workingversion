import type { OfficeChatMessage } from "./types";

export type OfficeChatAppendInput = Omit<OfficeChatMessage, "seq" | "ts"> & { operationId?: string };

/** The commit must atomically compare the counter and create message + replay record. */
export async function appendChatAtomically<T>(store: {
  replay: () => Promise<T | undefined>;
  counter: () => Promise<{ current?: number; last: number }>;
  commit: (sequence: number, expected: number | undefined) => Promise<T | undefined>;
}): Promise<T> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const replay = await store.replay();
    if (replay !== undefined) return replay;
    const counter = await store.counter();
    const result = await store.commit((counter.current ?? counter.last) + 1, counter.current);
    if (result !== undefined) return result;
    // Yield between contention retries; each retry rereads strongly consistent state.
    await new Promise((resolve) => setTimeout(resolve, Math.min(4 * (attempt + 1), 40)));
  }
  throw new Error("Chat history is busy. Please retry saving this message.");
}

/** Preserve a tab's message order and the same operation ID across a transport retry. */
export class OrderedChatAppender {
  private readonly tails = new Map<string, Promise<unknown>>();

  append<T>(documentId: string, send: (operationId: string) => Promise<T>): Promise<T> {
    const operationId = crypto.randomUUID();
    const result = (this.tails.get(documentId) ?? Promise.resolve()).then(async () => {
      try { return await send(operationId); }
      catch { return await send(operationId); }
    });
    const tail = result.catch(() => undefined);
    this.tails.set(documentId, tail);
    void tail.then(() => { if (this.tails.get(documentId) === tail) this.tails.delete(documentId); });
    return result;
  }
}
