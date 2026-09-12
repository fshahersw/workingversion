import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInterpreterRunner,
  INTERPRETER_LEASE_MS,
  INTERPRETER_SESSION_MS,
} from "./interpreter-registry.ts";
import { memoryInterpreterStore } from "../../../tests/support/interpreter-store-fixture.ts";

test("independent workers recover the same task's session, uploads, and artifact baseline", async () => {
  const { store } = memoryInterpreterStore();
  const first = createInterpreterRunner(store),
    second = createInterpreterRunner(store);
  await first("owner", "office:a", async (s) => {
    s.session = { id: "session-1", startedAt: Date.now() };
    s.seenFiles.add("deposition.docx");
    s.baselinedFor = "session-1";
    await s.checkpoint!();
  });
  await second("owner", "office:a", async (s) => {
    assert.equal(s.session?.id, "session-1");
    assert.equal(s.baselinedFor, "session-1");
    assert.deepEqual([...s.seenFiles], ["deposition.docx"]);
  });
  for (const [owner, scope] of [
    ["other", "office:a"],
    ["owner", "office:b"],
  ])
    await second(owner, scope, async (s) => {
      assert.equal(s.session, null);
      assert.equal(s.seenFiles.size, 0);
    });
});

test("concurrent workers serialize short operations and cannot overwrite the other worker's bookkeeping", async () => {
  const { store } = memoryInterpreterStore();
  const first = createInterpreterRunner(store),
    second = createInterpreterRunner(store);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const order: string[] = [];
  const a = first("owner", "office:a", async (s) => {
    order.push("first");
    await gate;
    s.seenFiles.add("a");
  });
  await Promise.resolve();
  const b = second("owner", "office:a", async (s) => {
    assert.ok(s.seenFiles.has("a"));
    order.push("second");
  });
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["first", "second"]);
});

test("expired abandoned leases are never stolen and cannot execute another operation", async () => {
  const { store } = memoryInterpreterStore();
  await store.claim("owner", "office:a", "dead-worker", 1);
  let calls = 0;
  await assert.rejects(
    createInterpreterRunner(store, () => INTERPRETER_LEASE_MS + 2)(
      "owner",
      "office:a",
      async () => {
        calls++;
      },
    ),
    /Interrupted/,
  );
  assert.equal(calls, 0);
});

test("a transport-uncertain task remains blocked on another worker even if the tool catches the error", async () => {
  const { store } = memoryInterpreterStore();
  const run = createInterpreterRunner(store);
  await assert.rejects(
    run("owner", "office:a", async (s) => {
      s.blockedReason = "has an unconfirmed execution";
      return "looks done";
    }),
    /unconfirmed/,
  );
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:a", async () =>
      assert.fail("must not execute"),
    ),
    /blocked/,
  );
});

test("expired sessions fail explicitly without replacement, including on repeated requests", async () => {
  const { store } = memoryInterpreterStore();
  await createInterpreterRunner(store, () => 1)("owner", "office:a", async (s) => {
    s.session = { id: "original", startedAt: 1 };
  });
  await assert.rejects(
    createInterpreterRunner(store, () => INTERPRETER_SESSION_MS)("owner", "office:a", async () =>
      assert.fail(),
    ),
    /expired/,
  );
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:a", async () => assert.fail()),
    /blocked/,
  );
});

test("checkpoint failure prevents the next remote action and poisons the session", async () => {
  const { store } = memoryInterpreterStore();
  const failing = {
    ...store,
    checkpoint: async () => {
      throw new Error("storage unavailable");
    },
  };
  let remoteCalls = 0;
  await assert.rejects(
    createInterpreterRunner(failing)("owner", "office:a", async (s) => {
      await s.checkpoint!();
      remoteCalls++;
    }),
    /verify/,
  );
  assert.equal(remoteCalls, 0);
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:a", async () => assert.fail()),
    /blocked/,
  );
});

test("finish failure cannot return a success or admit a second worker", async () => {
  const { store } = memoryInterpreterStore();
  const broken = {
    ...store,
    finish: async () => {
      throw new Error("write failed");
    },
  };
  await assert.rejects(
    createInterpreterRunner(broken)("owner", "office:a", async () => "done"),
    /save its final state/,
  );
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:a", async () => assert.fail()),
    /still processing/,
  );
});

test("ordinary completed tool errors release the claim and retain known state for correction", async () => {
  const { store } = memoryInterpreterStore();
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:a", async (s) => {
      s.seenFiles.add("input.csv");
      throw new Error("bad formula");
    }),
    /bad formula/,
  );
  await createInterpreterRunner(store)("owner", "office:a", async (s) =>
    assert.ok(s.seenFiles.has("input.csv")),
  );
});

test("overlong operations and oversized tracking state cannot report a reusable success", async () => {
  const { store } = memoryInterpreterStore();
  let now = 1;
  await assert.rejects(
    createInterpreterRunner(store, () => now)("owner", "office:a", async () => {
      now += INTERPRETER_LEASE_MS;
    }),
    /time limit/,
  );
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:b", async (s) => {
      s.seenFiles.add("x".repeat(121_000));
    }),
    /tracking limit/,
  );
  await assert.rejects(
    createInterpreterRunner(store)("owner", "office:b", async () => assert.fail()),
    /blocked/,
  );
});
