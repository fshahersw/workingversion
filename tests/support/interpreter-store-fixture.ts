import {
  EMPTY_SESSION,
  INTERPRETER_LEASE_MS,
  InterpreterBusyError,
  type InterpreterSessionStore,
  type SessionSnapshot,
} from "../../src/lib/agents/interpreter-registry.ts";

/** Test transport only: independent workers share this durable-storage substitute. */
export function memoryInterpreterStore() {
  const rows = new Map<string, { snapshot: SessionSnapshot; token?: string; until: number }>();
  const key = (owner: string, scope: string) => JSON.stringify([owner, scope]);
  const owned = (owner: string, scope: string, token: string) => {
    const row = rows.get(key(owner, scope));
    if (!row || row.token !== token) throw new Error("Lease lost");
    return row;
  };
  const store: InterpreterSessionStore = {
    async claim(owner, scope, token, now) {
      const k = key(owner, scope);
      const row = rows.get(k) ?? { snapshot: structuredClone(EMPTY_SESSION), until: 0 };
      if (row.snapshot.blockedReason) throw new Error("Workspace blocked; start a new task");
      if (row.token && row.token !== token) {
        if (row.until <= now) throw new Error("Interrupted operation; start a new task");
        throw new InterpreterBusyError();
      }
      row.token = token;
      row.until = now + INTERPRETER_LEASE_MS;
      rows.set(k, row);
      return { snapshot: structuredClone(row.snapshot), leaseUntil: row.until };
    },
    async checkpoint(owner, scope, token, snapshot, now) {
      const row = owned(owner, scope, token);
      if (row.until <= now) throw new Error("Lease expired");
      row.snapshot = structuredClone(snapshot);
    },
    async finish(owner, scope, token, snapshot) {
      const row = owned(owner, scope, token);
      row.snapshot = structuredClone(snapshot);
      delete row.token;
    },
  };
  return { store, rows, key };
}
