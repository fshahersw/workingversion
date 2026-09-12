// ============================================================================
// Speculative recency sweep runner (server-only).
//
// Fires the deterministic last-30-days web_search (prefetch-plan.ts) the
// moment a research turn starts, so it runs concurrently with the model's
// first turn instead of after it.
//
// The sweep runs against a SCRATCH SourceBook of its own. Nothing reaches the
// run's real book — and so the `sources` events, the coverage gate, or memory
// — unless the result is actually handed over. The hand-over happens exactly
// once, inside `take()`: the scratch sources are transplanted into the real
// book (deduped by its key, so a URL the run already holds keeps its ref), the
// scratch book's seen-URL set is folded into the real one (so the model's own
// search does not re-list what the sweep found), and every [S#] marker in the
// sweep text and every entry of its `refs` is remapped to the real book's
// refs. The caller appends the returned text to the model's first web_search
// result (a plain text enrichment; the Converse wire format is unchanged).
//
// Failure is silent: a sweep that errors, times out, is aborted, or is never
// consumed contributes nothing.
// ============================================================================
import { buildPrefetchPlan, type PrefetchPlan } from "./prefetch-plan";
import { executeTool, mergeSeen, SourceBook, type ToolOutcome } from "./tools.server";

/** Anything with executeTool's signature — injectable so tests need no network. */
export type PrefetchExecutor = typeof executeTool;

export type PrefetchOptions = {
  /** The request's signal: once it aborts, the sweep is given up at once. */
  signal?: AbortSignal;
  /** Executor override (default: the real executeTool). */
  execute?: PrefetchExecutor;
};

export type Prefetch = {
  plan: PrefetchPlan;
  /**
   * True while a hand-over is waiting on the sweep and once the sweep has been
   * handed to a tool result (or given up). A caller may read it to skip the
   * call; `take()` re-checks it itself.
   */
  consumed: boolean;
  /**
   * Hand over the sweep, once, if it has finished within `maxWaitMs`. Exactly
   * one caller ever receives the value: `consumed` flips before the wait, so a
   * concurrent caller gets null instead of a second copy. Returns null when
   * the sweep is still running after the wait (the claim is released and it
   * stays available for a later call), when it produced nothing, or when it
   * was already consumed. `take(0)` never waits: it hands over a settled sweep
   * and otherwise returns null without claiming it.
   */
  take(maxWaitMs?: number): Promise<ToolOutcome | null>;
  /** Milliseconds the sweep took (once settled). */
  ms(): number | null;
};

const PREFETCH_TIMEOUT_MS = 12_000;
const DEFAULT_TAKE_WAIT_MS = 4_000;
const REF_MARKER = /\[S(\d+)\]/g;

export function prefetchEnabled(): boolean {
  const flag = (process.env["RESEARCH_PREFETCH"] ?? "on").trim().toLowerCase();
  return !(flag === "off" || flag === "0" || flag === "false");
}

export function startPrefetch(
  query: string,
  book: SourceBook,
  opts?: PrefetchOptions,
): Prefetch | null {
  if (!prefetchEnabled()) return null;
  const signal = opts?.signal;
  if (signal?.aborted) return null;
  const plan = buildPrefetchPlan(query);
  if (!plan) return null;
  const execute = opts?.execute ?? executeTool;

  // The sweep's own book: its sources and seen-URL set stay here until (and
  // unless) a hand-over transplants them into the run's real book.
  const scratch = new SourceBook();
  const started = Date.now();
  let settledAt: number | null = null;
  let settled = false;
  let raw: ToolOutcome | null = null;

  const run = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const out = await Promise.race([
        execute(
          "web_search",
          { query: plan.query, queries: plan.queries, categories: plan.categories },
          scratch,
          { brave: true },
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PREFETCH_TIMEOUT_MS);
          if (signal) {
            onAbort = () => resolve(null);
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
      raw = out && out.hits > 0 && !signal?.aborted ? out : null;
    } catch {
      raw = null;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      settled = true;
      settledAt = Date.now();
    }
  })();

  /**
   * The one and only hand-over: move the scratch book's sources and seen set
   * into the real book and rewrite the sweep's refs to the real ones. It is
   * synchronous, so nothing can interleave with it, and `take()` guards it
   * with `consumed` so it runs at most once.
   */
  const handOver = (): ToolOutcome | null => {
    if (!raw) return null;
    const refMap = scratch.transplantInto(book);
    mergeSeen(scratch, book);
    // Single pass: a sequential replace could chain (S1 -> S2, then S2 -> S3).
    const text = raw.text.replace(REF_MARKER, (marker: string, n: string) => {
      const real = refMap.get(`S${n}`);
      return real ? `[${real}]` : marker;
    });
    const refs: string[] = [];
    for (const ref of raw.refs) {
      const real = refMap.get(ref);
      if (real && !refs.includes(real)) refs.push(real);
    }
    return { ...raw, text, refs };
  };

  const prefetch: Prefetch = {
    plan,
    consumed: false,
    ms: () => (settledAt === null ? null : settledAt - started),
    async take(maxWaitMs = DEFAULT_TAKE_WAIT_MS) {
      if (prefetch.consumed) return null;
      if (!settled) {
        // A probe never waits and never claims: the sweep stays available.
        if (maxWaitMs <= 0) return null;
        // Claim BEFORE awaiting so a concurrent caller sees `consumed` and
        // gets null rather than a second copy of the value.
        prefetch.consumed = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            run,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, maxWaitMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!settled) {
          // Still running: release the claim so a later call can pick it up.
          prefetch.consumed = false;
          return null;
        }
      }
      prefetch.consumed = true;
      return handOver();
    },
  };
  return prefetch;
}
