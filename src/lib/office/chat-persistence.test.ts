import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChatAtomically, OrderedChatAppender } from "./chat-persistence.ts";

test("concurrent messages allocate unique contiguous sequences and retries replay one message", async () => {
  let counter: number | undefined;
  const messages = new Map<number, string>();
  const operations = new Map<string, number>();
  const append = (id: string) => appendChatAtomically({
    replay: async () => operations.get(id),
    counter: async () => ({ current: counter, last: 4 }), // legacy history migration
    commit: async (sequence, expected) => {
      if (counter !== expected || messages.has(sequence) || operations.has(id)) return undefined;
      counter = sequence; messages.set(sequence, id); operations.set(id, sequence);
      return sequence;
    },
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => append(`message-${i}`)));
  assert.deepEqual([...results].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 5));
  assert.equal(await append("message-0"), results[0]);
  assert.equal(messages.size, 12);
});

test("ordered browser persistence retries with the same ID without blocking other documents", async () => {
  const queue = new OrderedChatAppender();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = []; const ids: string[] = [];
  let attempts = 0;
  const first = queue.append("A", async id => {
    ids.push(id); calls.push("A1");
    await gate;
    if (++attempts === 1) throw new Error("ambiguous transport failure");
    return "first";
  });
  const second = queue.append("A", async () => { calls.push("A2"); return "second"; });
  await queue.append("B", async () => { calls.push("B"); });
  assert.deepEqual(calls, ["A1", "B"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(calls, ["A1", "B", "A1", "A2"]);
});
