import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withInterpreterOwner as authenticatedOwner,
  withInterpreterScope,
  withInterpreterOperation,
  interpreterState,
} from "./interpreter-context.server.ts";

import { memoryInterpreterStore } from "../../../tests/support/interpreter-store-fixture.ts";
const { store } = memoryInterpreterStore();
const withInterpreterOwner = <T>(owner: string, work: () => T) =>
  authenticatedOwner(owner, work, store);

test("different authenticated owners cannot share a workspace even with identical client scope", async () => {
  const values = await Promise.all(
    ["one", "two"].map((owner) =>
      withInterpreterOwner(owner, () =>
        withInterpreterScope("office:same", async () => {
          const s = interpreterState();
          s.seenFiles.add(owner);
          await Promise.resolve();
          return [...s.seenFiles];
        }),
      ),
    ),
  );
  assert.deepEqual(values, [["one"], ["two"]]);
});
test("different Office tasks isolate files and variables for the same user", async () => {
  await withInterpreterOwner("three", async () => {
    const first = await withInterpreterScope("office:a", async () => {
      const state = interpreterState();
      state.session = { id: "fixture", startedAt: Date.now() };
      return state;
    });
    const second = await withInterpreterScope("office:b", async () => interpreterState());
    assert.notEqual(first, second);
    assert.deepEqual(
      (await withInterpreterScope("office:a", async () => interpreterState())).session,
      first.session,
    );
  });
});
test("same-task multi-step operations serialize, nested calls do not deadlock, failures release queue", async () => {
  const order: string[] = [];
  await withInterpreterOwner("four", async () => {
    const a = withInterpreterScope("office:test", async () => {
      order.push("write");
      await withInterpreterOperation(async () => {
        await Promise.resolve();
        order.push("run");
      });
      order.push("collect");
      throw new Error("expected");
    });
    const b = withInterpreterScope("office:test", async () => {
      order.push("second");
    });
    await assert.rejects(a, /expected/);
    await b;
  });
  assert.deepEqual(order, ["write", "run", "collect", "second"]);
});
test("unscoped execution and invalid client scopes fail closed", async () => {
  assert.throws(() => interpreterState(), /authenticated/);
  await withInterpreterOwner("five", async () => {
    assert.throws(() => withInterpreterScope("../other", async () => {}), /Invalid/);
  });
});
