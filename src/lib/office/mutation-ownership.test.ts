import assert from "node:assert/strict";
import { test } from "node:test";
import { MutationOwnership } from "./mutation-ownership.ts";

test("owned synchronous edits can be rolled back; interleaved manual edits cannot", () => {
  let doc = "start";
  const ownership = new MutationOwnership(() => doc, (a, b) => a === b);
  ownership.begin();
  ownership.run(() => { doc = "agent edit"; });
  assert.equal(ownership.canRollback(), true);
  doc = "manual edit";
  ownership.run(() => { doc += " and later agent edit"; });
  assert.equal(ownership.canRollback(), false);
  ownership.begin();
  ownership.run(() => { doc += " owned"; });
  doc += " user typed after last tool";
  assert.equal(ownership.canRollback(), false);
});

test("async reads remain rollback-safe but edits across an await are ambiguous", async () => {
  let doc = "start";
  const ownership = new MutationOwnership(() => doc, (a, b) => a === b);
  ownership.begin();
  await ownership.run(async () => "read result");
  assert.equal(ownership.canRollback(), true);
  await ownership.run(async () => { await Promise.resolve(); doc = "async edit"; });
  assert.equal(ownership.canRollback(), false);
});
