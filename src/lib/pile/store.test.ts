import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openMemoryPileStore, openPileStore } from "./store.ts";

test("set and get round-trip JSON with TTL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pile-"));
  const store = openPileStore(join(dir, "pile.sqlite"));
  store.set("sess:1", { ok: true }, 60_000);
  assert.deepEqual(store.get<{ ok: boolean }>("sess:1"), { ok: true });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("memory store round-trips JSON", () => {
  const store = openMemoryPileStore();
  store.set("sess:mem", { ok: true }, 60_000);
  assert.deepEqual(store.get<{ ok: boolean }>("sess:mem"), { ok: true });
  store.close();
});

test("expired keys are gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "pile-"));
  const store = openPileStore(join(dir, "pile.sqlite"));
  store.set("sess:dead", "x", 1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  assert.equal(store.get("sess:dead"), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
