import assert from "node:assert/strict";
import { test } from "node:test";

import {
  discoveryTabFor,
  stashWorkspaceHandoff,
  takeWorkspaceHandoff,
  workspaceHandoffKey,
} from "./workspace-handoff.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

test("each surface routes to its own Discovery tab", () => {
  assert.equal(discoveryTabFor("workingset"), "search");
  assert.equal(discoveryTabFor("deposition"), "deposition");
  assert.equal(discoveryTabFor("review"), "review");
});

test("surfaces never share a handoff key", () => {
  const keys = new Set(
    ["workingset", "deposition", "review"].map((s) => workspaceHandoffKey(s as never)),
  );
  assert.equal(keys.size, 3);
  // The Working Set key is the historical one; keep it stable.
  assert.equal(workspaceHandoffKey("workingset"), "kb:reloadWorkspace");
});

test("a stashed deposition id is only taken by the deposition tab, and only once", () => {
  const store = memoryStorage();
  stashWorkspaceHandoff("deposition", "item-1", store);
  assert.equal(takeWorkspaceHandoff("workingset", store), null);
  assert.equal(takeWorkspaceHandoff("review", store), null);
  assert.equal(takeWorkspaceHandoff("deposition", store), "item-1");
  assert.equal(takeWorkspaceHandoff("deposition", store), null);
  assert.equal(store.size(), 0);
});

test("blank ids are treated as absent and cleared", () => {
  const store = memoryStorage();
  store.setItem(workspaceHandoffKey("workingset"), "   ");
  assert.equal(takeWorkspaceHandoff("workingset", store), null);
  assert.equal(store.size(), 0);
});

test("missing storage is a no-op", () => {
  stashWorkspaceHandoff("deposition", "item-1", null);
  assert.equal(takeWorkspaceHandoff("deposition", null), null);
});

test("a throwing store does not propagate", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  stashWorkspaceHandoff("deposition", "item-1", broken);
  assert.equal(takeWorkspaceHandoff("deposition", broken), null);
});
