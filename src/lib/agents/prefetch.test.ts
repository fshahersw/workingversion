import assert from "node:assert/strict";
import { test } from "node:test";

// prefetch.server.ts reaches tools.server.ts, whose import graph (path aliases,
// extensionless specifiers) only a bundler-aware runtime resolves. Under the
// plain node runner the module cannot load, so these cases skip there and run
// under `bun test`.
const mods = await Promise.all([import("./prefetch.server.ts"), import("./tools.server.ts")]).then(
  ([prefetch, tools]) => ({ prefetch, tools }),
  () => null,
);
const skip = mods ? false : "prefetch.server.ts needs a bundler-aware runtime (run under bun test)";
function api() {
  if (!mods) throw new Error("unreachable: skipped");
  return mods;
}

type Executor = import("./prefetch.server.ts").PrefetchExecutor;
type Outcome = import("./tools.server.ts").ToolOutcome;
type Book = import("./tools.server.ts").SourceBook;

/** Yields a non-null plan (two distinctive terms, not conversational). */
const QUERY = "What is the current bellwether schedule in the Depo-Provera MDL 3140?";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A fake sweep: two hits added to whichever book the executor was handed, with
 * the text in categorySearch's `[S#] title — url` line format and the seen-URL
 * set populated the way rankResults would.
 */
function sweepInto(book: Book): Outcome {
  const { seenFor } = api().tools;
  const b = book.add(
    { citation: "B story", authority: "web", source_type: "news", source_url: "https://b.com/y", content: "B body" },
    { fullText: "B body full text" },
  );
  const a = book.add(
    { citation: "A story", authority: "web", source_type: "news", source_url: "https://a.com/x", content: "A body" },
    { fullText: "A body full text" },
  );
  seenFor(book).add("b.com/y");
  seenFor(book).add("a.com/x");
  return {
    text:
      `[${b.ref}] B story — https://b.com/y (as of 2026-09-01)\nB evidence\n\n` +
      `[${a.ref}] A story — https://a.com/x (as of 2026-09-02)\nA evidence`,
    hits: 2,
    refs: [b.ref, a.ref],
  };
}

test("exactly one of two concurrent take() calls receives the sweep", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook } = api().tools;
  const book = new SourceBook();
  const gate = deferred<void>();
  const execute: Executor = async (_name, _input, b) => {
    await gate.promise;
    return sweepInto(b);
  };
  const p = startPrefetch(QUERY, book, { execute });
  assert.ok(p);
  // Both calls start while the sweep is unsettled; the second sees the claim.
  const both = Promise.all([p.take(2_000), p.take(2_000)]);
  assert.equal(p.consumed, true);
  gate.resolve();
  const results = await both;
  const delivered = results.filter((r) => r !== null);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.hits, 2);
  assert.equal(p.consumed, true);
  // Once handed over, every later call gets nothing.
  assert.equal(await p.take(0), null);
  assert.equal(await p.take(100), null);
  // Transplanted exactly once.
  assert.equal(book.all().length, 2);
});

test("take(0) never blocks: null while unsettled (still available), the value once settled", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook } = api().tools;
  const book = new SourceBook();
  const gate = deferred<void>();
  const execute: Executor = async (_name, _input, b) => {
    await gate.promise;
    return sweepInto(b);
  };
  const p = startPrefetch(QUERY, book, { execute })!;
  assert.equal(await p.take(0), null);
  assert.equal(p.consumed, false); // a probe does not claim the sweep
  assert.equal(book.all().length, 0);
  gate.resolve();
  await until(() => p.ms() !== null);
  const out = await p.take(0);
  assert.ok(out);
  assert.equal(out.hits, 2);
  assert.equal(p.consumed, true);
  assert.equal(book.all().length, 2);
});

test("a wait that times out releases the claim so a later call can still take the sweep", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook } = api().tools;
  const book = new SourceBook();
  const gate = deferred<void>();
  const execute: Executor = async (_name, _input, b) => {
    await gate.promise;
    return sweepInto(b);
  };
  const p = startPrefetch(QUERY, book, { execute })!;
  assert.equal(await p.take(20), null);
  assert.equal(p.consumed, false);
  gate.resolve();
  const out = await p.take(2_000);
  assert.ok(out);
  assert.equal(p.consumed, true);
  assert.equal(book.all().length, 2);
});

test("a sweep that is never consumed leaves the real book untouched", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook, seenFor } = api().tools;
  const book = new SourceBook();
  let received: Book | null = null;
  const execute: Executor = async (_name, _input, b) => {
    received = b;
    return sweepInto(b);
  };
  const p = startPrefetch(QUERY, book, { execute })!;
  await until(() => p.ms() !== null);
  // The sweep ran against a scratch book, not the run's.
  assert.ok(received);
  assert.notEqual(received, book);
  assert.equal((received as Book).all().length, 2);
  // Nothing reached the real book: no sources, no verification text, no seen URLs.
  assert.equal(book.all().length, 0);
  assert.equal(book.fullTexts().length, 0);
  assert.equal(seenFor(book).size, 0);
  assert.equal(p.consumed, false);
});

test("hand-over transplants sources, remaps [S#] markers and refs, and dedupes against the real book", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook, seenFor } = api().tools;
  const book = new SourceBook();
  // The run already holds a.com/x as S1 (the model's own search found it).
  book.add({ citation: "A story", authority: "web", source_type: "news", source_url: "https://a.com/x", content: "A body" });
  // Scratch: S1 = b.com/y (new -> real S2), S2 = a.com/x (dup -> real S1). The
  // refs SWAP, so a sequential replace would chain (S1->S2, then S2->S1) and
  // corrupt the text; the remap must be a single pass.
  const execute: Executor = async (_name, _input, b) => sweepInto(b);
  const p = startPrefetch(QUERY, book, { execute })!;
  const out = await p.take(2_000);
  assert.ok(out);
  assert.equal(out.hits, 2);
  assert.deepEqual(out.refs, ["S2", "S1"]);
  assert.match(out.text, /^\[S2\] B story — https:\/\/b\.com\/y/);
  assert.match(out.text, /\n\[S1\] A story — https:\/\/a\.com\/x/);
  assert.equal((out.text.match(/\[S\d+\]/g) ?? []).length, 2);
  // Real book: no duplicate for a.com/x, b.com/y numbered after it.
  assert.deepEqual(
    book.all().map((s) => [s.ref, s.source_url]),
    [
      ["S1", "https://a.com/x"],
      ["S2", "https://b.com/y"],
    ],
  );
  // Verification text travels with the sources (and enriches the existing one).
  assert.ok(book.fullTexts().includes("B body full text"));
  assert.ok(book.fullTexts().includes("A body full text"));
  // The scratch seen set is folded into the real book's.
  assert.ok(seenFor(book).has("b.com/y"));
  assert.ok(seenFor(book).has("a.com/x"));
});

test("RESEARCH_PREFETCH=off disables the sweep", { skip }, () => {
  const { startPrefetch, prefetchEnabled } = api().prefetch;
  const { SourceBook } = api().tools;
  const prev = process.env["RESEARCH_PREFETCH"];
  process.env["RESEARCH_PREFETCH"] = "off";
  try {
    assert.equal(prefetchEnabled(), false);
    let calls = 0;
    const execute: Executor = async (_name, _input, b) => {
      calls++;
      return sweepInto(b);
    };
    assert.equal(startPrefetch(QUERY, new SourceBook(), { execute }), null);
    assert.equal(calls, 0);
  } finally {
    if (prev === undefined) delete process.env["RESEARCH_PREFETCH"];
    else process.env["RESEARCH_PREFETCH"] = prev;
  }
});

test("a throwing executor yields null without rejecting", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook } = api().tools;
  const book = new SourceBook();
  const rejecting: Executor = async () => {
    throw new Error("gateway down");
  };
  const p = startPrefetch(QUERY, book, { execute: rejecting })!;
  assert.equal(await p.take(2_000), null);
  assert.equal(p.consumed, true);
  assert.notEqual(p.ms(), null);
  assert.equal(book.all().length, 0);
  // A synchronous throw is swallowed the same way.
  const throwing = (() => {
    throw new Error("boom");
  }) as unknown as Executor;
  const p2 = startPrefetch(QUERY, new SourceBook(), { execute: throwing })!;
  assert.equal(await p2.take(2_000), null);
});

test("a sweep with no hits, or one the request signal aborts, hands over nothing", { skip }, async () => {
  const { startPrefetch } = api().prefetch;
  const { SourceBook } = api().tools;
  const empty: Executor = async () => ({ text: "No results.", hits: 0, refs: [] });
  const p = startPrefetch(QUERY, new SourceBook(), { execute: empty })!;
  assert.equal(await p.take(2_000), null);
  assert.equal(p.consumed, true);

  const book = new SourceBook();
  const gate = deferred<void>();
  const stuck: Executor = async (_name, _input, b) => {
    await gate.promise;
    return sweepInto(b);
  };
  const ac = new AbortController();
  const p2 = startPrefetch(QUERY, book, { execute: stuck, signal: ac.signal })!;
  const pending = p2.take(10_000);
  ac.abort();
  // Resolves on the abort, not after the 10s wait.
  assert.equal(await pending, null);
  assert.equal(p2.consumed, true);
  gate.resolve();
  await until(() => p2.ms() !== null);
  assert.equal(book.all().length, 0);
  // An already-aborted request starts no sweep at all.
  assert.equal(startPrefetch(QUERY, new SourceBook(), { execute: stuck, signal: ac.signal }), null);
});
