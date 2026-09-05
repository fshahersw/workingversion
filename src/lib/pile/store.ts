import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type PileStore = {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown, ttlMs: number): void;
  del(key: string): void;
  close(): void;
};

type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (key: string) => unknown;
    run: (...args: unknown[]) => void;
  };
  close: () => void;
};

function openMemoryStore(): PileStore {
  const kv = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();
  const sweep = () => {
    const t = now();
    for (const [key, row] of kv) {
      if (row.expiresAt <= t) kv.delete(key);
    }
  };
  return {
    get<T = unknown>(key: string): T | null {
      sweep();
      const row = kv.get(key);
      if (!row) return null;
      return JSON.parse(row.value) as T;
    },
    set(key: string, value: unknown, ttlMs: number) {
      sweep();
      kv.set(key, { value: JSON.stringify(value), expiresAt: now() + Math.max(1, ttlMs) });
    },
    del(key: string) {
      kv.delete(key);
    },
    close() {
      kv.clear();
    },
  };
}

function openSqliteStore(filePath: string): PileStore {
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at);
  `);

  const select = db.prepare("SELECT value, expires_at FROM kv WHERE key = ?");
  const upsert = db.prepare(
    "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  );
  const remove = db.prepare("DELETE FROM kv WHERE key = ?");
  const sweepStmt = db.prepare("DELETE FROM kv WHERE expires_at <= ?");
  const now = () => Date.now();

  return {
    get<T = unknown>(key: string): T | null {
      sweepStmt.run(now());
      const row = select.get(key) as { value: string; expires_at: number } | undefined;
      if (!row) return null;
      if (row.expires_at <= now()) {
        remove.run(key);
        return null;
      }
      return JSON.parse(row.value) as T;
    },
    set(key: string, value: unknown, ttlMs: number) {
      sweepStmt.run(now());
      upsert.run(key, JSON.stringify(value), now() + Math.max(1, ttlMs));
    },
    del(key: string) {
      remove.run(key);
    },
    close() {
      db.close();
    },
  };
}

/** SQLite when Node provides it; in-memory if the host cannot (Lovable / locked file). */
export function openPileStore(filePath: string): PileStore {
  try {
    return openSqliteStore(filePath);
  } catch {
    return openMemoryStore();
  }
}

export function openMemoryPileStore(): PileStore {
  return openMemoryStore();
}
