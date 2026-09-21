import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeFailedRun } from "./finalize-failed-run.ts";

test("save and busy release wait for pending edits and successful rollback", async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = finalizeFailedRun({
    settle: async () => { log.push("apply"); return true; },
    restore: async () => { log.push("restore start"); await gate; log.push("restored"); return true; },
    save: async () => { log.push("save"); },
    onError: () => assert.fail("unexpected failure"),
    finish: () => { log.push("release busy"); },
  });
  await Promise.resolve();
  assert.deepEqual(log, ["apply", "restore start"]);
  release();
  await run;
  assert.deepEqual(log, ["apply", "restore start", "restored", "save", "release busy"]);
});

test("incomplete or rejected rollback never autosaves and always releases busy", async () => {
  for (const throws of [false, true]) {
    let saved = false; let finished = false; let error = false;
    await finalizeFailedRun({
      settle: async () => undefined,
      restore: async () => { if (throws) throw new Error("restore failed"); return false; },
      save: async () => { saved = true; },
      onError: () => { error = true; },
      finish: () => { finished = true; },
    });
    assert.equal(saved, false); assert.equal(finished, true); assert.equal(error, throws);
  }
});
