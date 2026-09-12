import { randomUUID } from "node:crypto";
import type { InterpreterState } from "./interpreter-context.server";

export type SessionSnapshot = {
  session: InterpreterState["session"];
  seenFiles: string[];
  baselinedFor: string | null;
  blockedReason?: string;
};
export type SessionClaim = { snapshot: SessionSnapshot; leaseUntil: number };
export interface InterpreterSessionStore {
  claim(owner: string, scope: string, token: string, now: number): Promise<SessionClaim>;
  checkpoint(
    owner: string,
    scope: string,
    token: string,
    state: SessionSnapshot,
    now: number,
  ): Promise<void>;
  finish(
    owner: string,
    scope: string,
    token: string,
    state: SessionSnapshot,
    now: number,
  ): Promise<void>;
}

// Exceeds the application's maximum 15-minute Lambda invocation. An expired
// claim is NEVER stolen: remote Python may still be executing after a worker dies.
export const INTERPRETER_LEASE_MS = 20 * 60_000;
export const INTERPRETER_SESSION_MS = 30 * 60_000;
export const INTERPRETER_EXPIRY_MARGIN_MS = 120_000;
export const INTERPRETER_RECORD_TTL_SECONDS = 7 * 86400;
export const EMPTY_SESSION: SessionSnapshot = { session: null, seenFiles: [], baselinedFor: null };
export class InterpreterBusyError extends Error {
  constructor() {
    super(
      "This Python task is still processing another operation. Wait for it to finish before retrying.",
    );
  }
}

export function workspaceUnavailable(reason: string): Error {
  return new Error(
    `Python workspace ${reason}. Start a new task and reattach the required files; the previous operation will not be replayed.`,
  );
}

/** Hydrates one owner/task on every operation. No process-local session cache. */
export function createInterpreterRunner(store: InterpreterSessionStore, now = Date.now) {
  return async function run<T>(
    owner: string,
    scope: string,
    work: (state: InterpreterState) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    let claim!: SessionClaim;
    for (let attempt = 0; ; attempt++) {
      try {
        claim = await store.claim(owner, scope, token, now());
        break;
      } catch (error) {
        // Only acquisition is retried, before any tool or model side effect.
        if (!(error instanceof InterpreterBusyError) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    const state: InterpreterState = {
      ...claim.snapshot,
      seenFiles: new Set(claim.snapshot.seenFiles),
      starting: null,
      tail: Promise.resolve(),
      active: 1,
      usedAt: now(),
    };
    const snapshot = (): SessionSnapshot => {
      const saved: SessionSnapshot = {
        session: state.session,
        seenFiles: [...state.seenFiles],
        baselinedFor: state.baselinedFor,
        ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
      };
      // Keep the entire DynamoDB row comfortably below 400 KiB. Never silently
      // discard live artifact bookkeeping and then claim successful persistence.
      if (Buffer.byteLength(JSON.stringify(saved), "utf8") > 120_000) {
        state.blockedReason = "exceeded its file tracking limit";
        return { ...saved, seenFiles: [], blockedReason: state.blockedReason };
      }
      return saved;
    };
    state.checkpoint = async () => {
      if (now() >= claim.leaseUntil) state.blockedReason = "exceeded its operation time limit";
      const saved = snapshot();
      if (saved.blockedReason) throw workspaceUnavailable(saved.blockedReason);
      try {
        await store.checkpoint(owner, scope, token, saved, now());
      } catch {
        state.blockedReason = "could not verify its saved session or exclusive access";
        throw workspaceUnavailable(state.blockedReason);
      }
    };
    let value!: T;
    let workError: unknown;
    let workFailed = false;
    try {
      if (
        state.session &&
        now() - state.session.startedAt >= INTERPRETER_SESSION_MS - INTERPRETER_EXPIRY_MARGIN_MS
      )
        state.blockedReason = "expired";
      if (state.blockedReason) throw workspaceUnavailable(state.blockedReason);
      value = await work(state);
      if (now() >= claim.leaseUntil) state.blockedReason = "exceeded its operation time limit";
      if (snapshot().blockedReason) throw workspaceUnavailable(state.blockedReason!);
    } catch (error) {
      workFailed = true;
      workError = error;
    }
    // Persist both success and failure before exposing either result. A failed
    // save takes precedence, because the workspace cannot safely be reused.
    if (now() >= claim.leaseUntil) state.blockedReason = "exceeded its operation time limit";
    try {
      await store.finish(owner, scope, token, snapshot(), now());
    } catch {
      throw workspaceUnavailable("could not save its final state");
    }
    if (workFailed) throw workError;
    return value;
  };
}
