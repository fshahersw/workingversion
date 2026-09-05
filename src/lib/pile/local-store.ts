import type { PileFile, PilePage, PileSession } from "./types";

const DB = "wr-working-set";
const STORE = "pile";
const KEY = "current";

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

export async function saveLocalPile(session: PileSession, pages: PilePage[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ session, pages, savedAt: Date.now() } satisfies PersistedPile, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
  });
  db.close();
}

export async function loadLocalPile(): Promise<PersistedPile | null> {
  const db = await openDb();
  const row = await new Promise<PersistedPile | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as PersistedPile | undefined);
    req.onerror = () => reject(req.error ?? new Error("indexedDB read failed"));
  });
  db.close();
  if (!row?.session?.files?.length || !row.pages?.length) return null;
  return row;
}

export async function clearLocalPile(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"));
  });
  db.close();
}
