// ============================================================================
// Run state: a short-TTL key/value store + a per-run research scratchpad.
//
// WHY THIS EXISTS
//   The multi-round research loop wants two things that outlive a single tool
//   call but not the process:
//     1. A short-TTL CACHE of upstream tool results, so the same AgentCore /
//        DocketBird search issued twice (across rounds, across sub-agents, or
//        across a conversation's turns) is fetched once.
//     2. A place to hang a running SCRATCHPAD the router maintains round over
//        round (what's been found, what's still open, how confident it is).
//
//   Today both live IN MEMORY, behind the tiny `KVStore` interface below. That
//   interface is the seam: when the app grows past one instance, or the cache
//   should survive a redeploy, drop in a Redis-backed KVStore here (read a
//   REDIS_URL, implement get/set/getPending) and nothing else in the codebase
//   changes. Until then an extra network hop and a Redis dependency would buy
//   nothing, so we don't take them.
// ============================================================================
import type { LitAgentKey } from "./prompts";

// ---------------------------------------------------------------------------
// KV store interface (the Redis seam) + in-memory implementation
// ---------------------------------------------------------------------------

export interface KVStore {
  /** Returns the stored value if present and unexpired, else undefined. */
  get<T>(key: string): Promise<T | undefined>;
  /** Stores a value under a TTL (milliseconds). */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

type Entry = { value: unknown; expires: number };

/**
 * Process-local TTL map. Lazily evicts on read; a periodic sweep keeps a long
 * idle process from leaking expired entries. Single-instance only — a second
 * server instance has its own map (that's the cue to move to Redis).
 */
class MemoryKV implements KVStore {
  private map = new Map<string, Entry>();
  private lastSweep = Date.now();

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expires: Date.now() + Math.max(0, ttlMs) });
    this.sweep();
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }
}

let store: KVStore = new MemoryKV();

/** Swap the backing store (e.g. a Redis implementation) at boot if desired. */
export function setStore(next: KVStore): void {
  store = next;
}
export function getStore(): KVStore {
  return store;
}

// ---------------------------------------------------------------------------
// memoTTL — cache-or-compute with in-flight de-duplication
// ---------------------------------------------------------------------------

// Collapses concurrent identical computes (e.g. two sub-agents firing the same
// search in the same round) into one upstream call. Pending promises are held
// locally — they represent in-flight work in THIS process regardless of store.
const pending = new Map<string, Promise<unknown>>();

/**
 * Returns the cached value for `key`, or runs `compute`, caches its result for
 * `ttlMs`, and returns it. Concurrent callers with the same key await one
 * compute. `compute` failures are never cached and reject every waiter.
 */
export async function memoTTL<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = await store.get<T>(key);
  if (hit !== undefined) return hit;

  const inFlight = pending.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const p = (async () => {
    try {
      const value = await compute();
      await store.set(key, value, ttlMs);
      return value;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

/** Stable cache key from a tool name and its arguments (order-insensitive). */
export function toolCacheKey(tool: string, args: Record<string, unknown>): string {
  const norm: Record<string, string> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    norm[k] = String(v).trim().toLowerCase();
  }
  return `tool:${tool}:${JSON.stringify(norm)}`;
}

/** Default TTL for cached tool results — long enough to cover a conversation,
 *  short enough that a re-run after a few minutes re-fetches fresh. */
export const TOOL_CACHE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Research scratchpad — the router's round-over-round working memory
// ---------------------------------------------------------------------------

/**
 * What the router carries between rounds. It is produced BY the router (via the
 * plan tool) and fed back into the next planning call, so decisions build on an
 * explicit state rather than re-deriving everything from the raw transcript.
 */
export type Scratchpad = {
  /** Terse, durable findings established so far (each ideally tagged with S#). */
  findings: string[];
  /** Concrete sub-questions still unresolved — the agenda for later rounds. */
  openThreads: string[];
  /** The router's own confidence that the question can now be answered well. */
  confidence: "low" | "medium" | "high";
  /** One short line on what the last round changed / why the next step. */
  note: string;
};

export function emptyScratchpad(): Scratchpad {
  return { findings: [], openThreads: [], confidence: "low", note: "" };
}

/**
 * Fold a plan's freshly-emitted scratchpad fields onto the carried state.
 * Findings accumulate (deduped, capped); open threads and confidence are
 * replaced by the router's latest read; note is the latest line.
 */
export function mergeScratchpad(prev: Scratchpad, next: Partial<Scratchpad>): Scratchpad {
  const findings = dedupeCap([...prev.findings, ...(next.findings ?? [])], 24);
  const openThreads = (next.openThreads ?? prev.openThreads)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  return {
    findings,
    openThreads,
    confidence: next.confidence ?? prev.confidence,
    note: (next.note ?? "").trim() || prev.note,
  };
}

function dedupeCap(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Render the scratchpad for the router prompt — compact, machine-facing. */
export function renderScratchpad(sp: Scratchpad): string {
  if (!sp.findings.length && !sp.openThreads.length && !sp.note) {
    return "SCRATCHPAD\n(empty — this is the first planning pass)";
  }
  const lines = ["SCRATCHPAD (your running state — update it this round)"];
  lines.push(`confidence: ${sp.confidence}`);
  if (sp.note) lines.push(`last note: ${sp.note}`);
  if (sp.findings.length) {
    lines.push("established findings:");
    for (const f of sp.findings) lines.push(`  - ${f}`);
  }
  if (sp.openThreads.length) {
    lines.push("still open:");
    for (const t of sp.openThreads) lines.push(`  - ${t}`);
  }
  return lines.join("\n");
}

/** Per-agent record of foci already dispatched, so the router escalates
 *  instead of re-running a near-identical focus in a later round. */
export type DispatchLedger = Partial<Record<LitAgentKey, string[]>>;
