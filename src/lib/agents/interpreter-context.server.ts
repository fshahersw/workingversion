import { AsyncLocalStorage } from "node:async_hooks";
import { createInterpreterRunner, type InterpreterSessionStore } from "./interpreter-registry";

type Session = { id: string; startedAt: number };
export type InterpreterState = {
  session: Session | null;
  starting: Promise<Session> | null;
  seenFiles: Set<string>;
  baselinedFor: string | null;
  tail: Promise<void>;
  active: number;
  usedAt: number;
  dispose?: () => Promise<void>;
  /** Present for durable Office workspaces; checkpoint before any remote action. */
  checkpoint?: () => Promise<void>;
  blockedReason?: string;
  rpcTail?: Promise<void>;
};
type Context = {
  owner: string;
  scope: string;
  locked?: InterpreterState;
  officeStore?: InterpreterSessionStore;
};
const context = new AsyncLocalStorage<Context>();
const pool = new Map<string, InterpreterState>();
const MAX_SCOPES = 128;
const IDLE_MS = 30 * 60_000;

/** Identity always comes from verified server auth, never a tool argument. */
export function withInterpreterOwner<T>(
  owner: string,
  work: () => T,
  officeStore?: InterpreterSessionStore,
): T {
  if (!owner) throw new Error("Authenticated interpreter owner required.");
  return context.run({ owner, scope: "research", officeStore }, work);
}
export function interpreterOwner(): string {
  const owner = context.getStore()?.owner;
  if (!owner) throw new Error("Python requires an authenticated request context.");
  return owner;
}
export function interpreterState(): InterpreterState {
  const ctx = context.getStore();
  if (!ctx) throw new Error("Python requires an authenticated request context.");
  if (ctx.locked) return ctx.locked;
  if (ctx.scope.startsWith("office:"))
    throw new Error("Office Python requires an acquired session operation.");
  const key = JSON.stringify([ctx.owner, ctx.scope]);
  const now = Date.now();
  for (const [id, state] of pool) {
    if (!state.active && now - state.usedAt >= IDLE_MS) {
      pool.delete(id);
      void state.dispose?.().catch(() => {});
    }
  }
  let state = pool.get(key);
  if (!state) {
    // Never evict a live workspace merely to admit another request.
    if (pool.size >= MAX_SCOPES) throw new Error("Python workspaces are busy. Retry shortly.");
    state = {
      session: null,
      starting: null,
      seenFiles: new Set(),
      baselinedFor: null,
      tail: Promise.resolve(),
      active: 0,
      usedAt: now,
    };
    pool.set(key, state);
  }
  state.usedAt = now;
  return state;
}

/** Serialize the entire write/run/collect operation, with reentrant nested tools. */
export async function withInterpreterOperation<T>(work: () => Promise<T>): Promise<T> {
  const ctx = context.getStore();
  if (!ctx) throw new Error("Python requires an authenticated request context.");
  if (ctx.locked) return work();
  const state = interpreterState();
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.active++;
  await previous;
  try {
    return await context.run({ ...ctx, locked: state }, work);
  } finally {
    state.active--;
    state.usedAt = Date.now();
    if (!state.active && !state.session && !state.starting)
      pool.delete(JSON.stringify([ctx.owner, ctx.scope]));
    release();
  }
}

export function withInterpreterScope<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const owner = interpreterOwner();
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(scope)) throw new Error("Invalid Python task scope.");
  const ctx = context.getStore();
  if (ctx?.scope === scope) return withInterpreterOperation(work);
  if (scope.startsWith("office:")) {
    return (async () => {
      const store =
        ctx?.officeStore ??
        (await (await import("./interpreter-store.server")).officeInterpreterStore());
      return createInterpreterRunner(store)(owner, scope, (state) =>
        context.run({ owner, scope, locked: state, officeStore: store }, work),
      );
    })();
  }
  return context.run({ owner, scope }, () => withInterpreterOperation(work));
}

/** Release one completed temporary extraction workspace; never interrupt active work. */
export async function closeInterpreterScope(scope: string) {
  if (scope.startsWith("office:")) {
    try {
      await withInterpreterScope(scope, async () => {
        const state = interpreterState();
        state.blockedReason = "closed";
        if (state.session) {
          const { stopInterpreterSession } = await import("./code-interpreter.server");
          await stopInterpreterSession(state.session.id);
        }
      });
    } catch {
      // Cleanup is best effort. Keep the tombstone; ambiguous operations are
      // never reopened for cleanup, and the remote session also has a hard TTL.
    }
    return;
  }
  const key = JSON.stringify([interpreterOwner(), scope]);
  const state = pool.get(key);
  if (!state || state.active) return;
  pool.delete(key);
  await state.dispose?.().catch(() => {});
}
