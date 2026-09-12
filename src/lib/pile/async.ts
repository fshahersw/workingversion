export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpStatusError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) {
    const ms = sec > 120 ? sec : sec * 1000;
    return Math.min(30_000, Math.max(250, ms));
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.min(30_000, Math.max(250, when - Date.now()));
}

export function isRateLimited(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status === 429 || err.status === 503;
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP 429|HTTP 503|Throttl|Too many requests|TooManyRequests/i.test(msg);
}

export function isRetryableHttp(err: unknown): boolean {
  if (isRateLimited(err)) return true;
  if (err instanceof HttpStatusError) return err.status >= 500;
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP 5\d\d|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

export function retryAfterMsFrom(err: unknown): number | undefined {
  if (err instanceof HttpStatusError) return err.retryAfterMs;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retry-after=([\d.]+)/i);
  if (!m) return undefined;
  return parseRetryAfterMs(m[1]);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; signal?: AbortSignal; retry429?: boolean } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (isRateLimited(e) && opts.retry429 === false) throw e;
      const msg = e instanceof Error ? e.message : "";
      if (/HTTP 4\d\d/.test(msg) && !isRateLimited(e))
        throw e instanceof Error ? e : new Error(msg);
      if (e instanceof HttpStatusError && e.status < 500 && e.status !== 429 && e.status !== 503)
        throw e;
      if (i === tries - 1) break;
      const ra = retryAfterMsFrom(e);
      await sleep(ra ?? (opts.baseMs ?? 400) * 2 ** i, opts.signal);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        if (failed) return;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i]!, i);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  if (!items.length) return [];
  // Drain work already started before reporting an error. Otherwise callers
  // can finalize a partial record while other workers keep mutating it.
  const results = await Promise.allSettled(workers);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return out;
}

/** AIMD limiter: raise in-flight on success, halve + cooldown on 429. Does not change how many items run. */
export class AdaptiveLimiter {
  readonly min: number;
  readonly max: number;
  limit: number;
  inflight = 0;
  private cooldownUntil = 0;
  private successes = 0;
  private waiters: Array<() => void> = [];

  constructor(min: number, start: number, max: number) {
    this.min = min;
    this.max = max;
    this.limit = Math.min(max, Math.max(min, start));
  }

  private wake() {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  private async waitTurn(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const now = Date.now();
      if (this.inflight < this.limit && now >= this.cooldownUntil) {
        this.inflight += 1;
        return;
      }
      const waitMs = Math.max(25, this.cooldownUntil - now);
      const sleeper = sleep(Math.min(waitMs, 500), signal);
      const turn = this.waitTurn(signal);
      await Promise.race([sleeper, turn]);
    }
  }

  succeed() {
    this.inflight = Math.max(0, this.inflight - 1);
    this.successes += 1;
    if (this.successes >= 3 && this.limit < this.max) {
      this.limit += 1;
      this.successes = 0;
    }
    this.wake();
  }

  fail(kind: "rate" | "error", retryAfterMs?: number) {
    this.inflight = Math.max(0, this.inflight - 1);
    if (kind === "rate") {
      this.successes = 0;
      this.limit = Math.max(this.min, Math.floor(this.limit / 2) || this.min);
      this.cooldownUntil = Date.now() + (retryAfterMs ?? 1200);
    }
    this.wake();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, tries = 8): Promise<T> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      await this.acquire(signal);
      try {
        const value = await fn();
        this.succeed();
        return value;
      } catch (e) {
        last = e;
        if (e instanceof DOMException && e.name === "AbortError") {
          this.fail("error");
          throw e;
        }
        const rate = isRateLimited(e);
        this.fail(rate ? "rate" : "error", retryAfterMsFrom(e));
        if (!isRetryableHttp(e) || i === tries - 1) throw e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

export async function mapPoolAdaptive<T, R>(
  items: T[],
  opts: { min: number; start: number; max: number; signal?: AbortSignal },
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; limiter: AdaptiveLimiter }> {
  const limiter = new AdaptiveLimiter(opts.min, opts.start, opts.max);
  if (!items.length) return { results: [], limiter };
  const results = await mapPool(
    items,
    opts.max,
    (item, index) => limiter.run(() => fn(item, index), opts.signal),
    opts.signal,
  );
  return { results, limiter };
}
