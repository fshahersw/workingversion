/** A queue belongs to one editor generation, never to the next opened file. */
export type SessionGeneration = {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  tail: Promise<unknown>;
};

export class OfficeSessionQueue {
  private current: SessionGeneration | null = null;
  private openTail: Promise<unknown> = Promise.resolve();

  begin(signal?: AbortSignal): SessionGeneration {
    this.invalidate();
    const controller = new AbortController();
    const generation = { controller, signal: controller.signal, tail: Promise.resolve() };
    this.current = generation;
    if (signal?.aborted) controller.abort();
    else if (signal) {
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", () => signal.removeEventListener("abort", abort), { once: true });
    }
    return generation;
  }

  assertCurrent(generation: SessionGeneration): void {
    if (generation !== this.current || generation.signal.aborted) {
      throw new Error("The document session changed. This operation was stopped.");
    }
  }

  invalidate(): void {
    this.current?.controller.abort();
    this.current = null;
  }

  /** Opens may evict an existing worker for the same file. Finish closing an
   * abandoned open before allowing the next generation to open its worker. */
  open<T>(generation: SessionGeneration, run: () => Promise<T>, discard: (value: T) => Promise<void>): Promise<T> {
    const result = this.openTail.then(async () => {
      this.assertCurrent(generation);
      const value = await run();
      try { this.assertCurrent(generation); }
      catch (error) { await discard(value); throw error; }
      return value;
    });
    this.openTail = result.catch(() => undefined);
    return result;
  }

  enqueue<T>(generation: SessionGeneration, run: () => Promise<T>): Promise<T> {
    const result = generation.tail.then(async () => {
      this.assertCurrent(generation);
      const value = await run();
      this.assertCurrent(generation);
      return value;
    });
    generation.tail = result.catch(() => undefined);
    return result;
  }
}
