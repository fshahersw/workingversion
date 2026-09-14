// node --experimental-strip-types --test src/lib/pile/pending-workspaces.test.ts
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

// Minimal localStorage mock installed before importing the module under test.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const { listPendingWorkspaces, addPendingWorkspace, removePendingWorkspace } = await import(
  "./pending-workspaces.ts"
);

beforeEach(() => store.clear());

test("add is deduped by itemId and round-trips", () => {
  addPendingWorkspace({ itemId: "a", name: "Set A", surface: "workingset" });
  addPendingWorkspace({ itemId: "a", name: "Set A renamed", surface: "workingset" });
  addPendingWorkspace({ itemId: "b", name: "Depo B", surface: "deposition" });
  const list = listPendingWorkspaces();
  assert.equal(list.length, 2);
  assert.equal(list.find((p) => p.itemId === "a")?.name, "Set A renamed");
  assert.equal(list.find((p) => p.itemId === "b")?.surface, "deposition");
});

test("remove drops only the matching entry and clears storage when empty", () => {
  addPendingWorkspace({ itemId: "a", name: "A", surface: "workingset" });
  addPendingWorkspace({ itemId: "b", name: "B", surface: "workingset" });
  removePendingWorkspace("a");
  assert.deepEqual(
    listPendingWorkspaces().map((p) => p.itemId),
    ["b"],
  );
  removePendingWorkspace("b");
  assert.equal(listPendingWorkspaces().length, 0);
  assert.equal(store.has("kb:pendingWorkspaces"), false, "empty list removes the key");
});

test("stale entries past the max age are ignored", () => {
  const old = Date.now() - 31 * 60_000;
  store.set(
    "kb:pendingWorkspaces",
    JSON.stringify([{ itemId: "old", name: "Old", surface: "workingset", startedAt: old }]),
  );
  assert.equal(listPendingWorkspaces().length, 0);
});

test("malformed storage never throws", () => {
  store.set("kb:pendingWorkspaces", "{not json");
  assert.deepEqual(listPendingWorkspaces(), []);
  store.set("kb:pendingWorkspaces", JSON.stringify({ notAnArray: true }));
  assert.deepEqual(listPendingWorkspaces(), []);
});
