import assert from "node:assert/strict";
import { test } from "node:test";
import { OfficeSessionQueue } from "./session-queue.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

test("navigation aborts the old transport, suppresses its reply and never runs its queued edit", async () => {
  const queue = new OfficeSessionQueue();
  const a = queue.begin();
  const gate = deferred<string>();
  const effects: string[] = [];
  const first = queue.enqueue(a, async () => {
    const result = await gate.promise;
    queue.assertCurrent(a); // production hosts check before publishing events/state
    effects.push(result);
  });
  const second = queue.enqueue(a, async () => { effects.push("old edit"); });
  const firstRejected = assert.rejects(first, /session changed/);
  const secondRejected = assert.rejects(second, /session changed/);
  await Promise.resolve();
  const b = queue.begin();
  assert.equal(a.signal.aborted, true);
  await queue.enqueue(b, async () => { effects.push("new document"); });
  gate.resolve("late old response");
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(effects, ["new document"]);
});

test("same-session operations stay ordered and a failure does not poison later operations", async () => {
  const queue = new OfficeSessionQueue();
  const generation = queue.begin();
  const effects: number[] = [];
  const failed = queue.enqueue(generation, async () => { effects.push(1); throw new Error("expected"); });
  const rejected = assert.rejects(failed, /expected/);
  await queue.enqueue(generation, async () => { effects.push(2); });
  await rejected;
  assert.deepEqual(effects, [1, 2]);
});

test("aborted boot cannot publish or enqueue while a new generation remains usable", async () => {
  const queue = new OfficeSessionQueue();
  const controller = new AbortController();
  const a = queue.begin(controller.signal);
  controller.abort();
  assert.throws(() => queue.assertCurrent(a), /session changed/);
  const b = queue.begin();
  queue.assertCurrent(b);
  queue.invalidate();
  await assert.rejects(queue.enqueue(b, async () => true), /session changed/);
});

test("a stale open is closed before the new worker opens, including reopening the same file", async () => {
  const queue = new OfficeSessionQueue();
  const a = queue.begin();
  const gate = deferred<string>();
  const events: string[] = [];
  const opening = queue.open(a, async () => { events.push("open A"); return gate.promise; }, async id => {
    events.push(`close ${id}`);
  });
  const rejected = assert.rejects(opening, /session changed/);
  await Promise.resolve();
  const b = queue.begin();
  const next = queue.open(b, async () => { events.push("open B"); return "B"; }, async () => undefined);
  await Promise.resolve();
  assert.deepEqual(events, ["open A"]);
  gate.resolve("A");
  await rejected;
  assert.equal(await next, "B");
  assert.deepEqual(events, ["open A", "close A", "open B"]);
});
