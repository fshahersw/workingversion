import type { PileFile, PilePage, PileSession } from "./types";

const DB = "wr-working-set";
const STORE = "pile";
// Legacy fixed key: every user on a shared browser profile wrote/read the same
// blob, so User B could see User A's working set. Piles are now namespaced by the
// verified Cognito principal; the legacy key is purged on load.
const LEGACY_KEY = "current";

function keyFor(owner: string): string {
  return `pile:${owner}`;
}

export type PersistedPile = {
  session: PileSession;
  pages: PilePage[];
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export async function saveLocalPile(
  owner: string,
  session: PileSession,
  pages: PilePage[],
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(
      { session, pages, savedAt: Date.now() } satisfies PersistedPile,
      keyFor(owner),
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
  });
  db.close();
}

export async function loadLocalPile(owner: string): Promise<PersistedPile | null> {
  const db = await openDb();
  const row = await new Promise<PersistedPile | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(keyFor(owner));
    req.onsuccess = () => resolve(req.result as PersistedPile | undefined);
    req.onerror = () => reject(req.error ?? new Error("indexedDB read failed"));
  });
  db.close();
  if (!row?.session?.files?.length || !row.pages?.length) return null;
  return row;
}

export async function clearLocalPile(owner: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(keyFor(owner));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"));
  });
  db.close();
}

/** Best-effort removal of the pre-namespacing shared blob. Idempotent. */
export async function purgeLegacyPile(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(LEGACY_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}
