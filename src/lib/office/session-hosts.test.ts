import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transform } from "esbuild";
import { OfficeSessionQueue } from "./session-queue.ts";
import { OrderedChatAppender } from "./chat-persistence.ts";
import { officeStreamFailure } from "./stream-errors.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

for (const app of ["sheets", "slides"] as const) {
  test(`${app} actual host binds queued edits and late replies to their original session`, async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousFetch = globalThis.fetch;
    const previousWindow = globals.window;
    const events: unknown[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
    const gate = deferred<Response>();
    const started = deferred<void>();
    const listeners = new Map<string, (event: { persisted: boolean }) => void>();
    let invoke!: (channel: string, args: unknown[]) => Promise<unknown>;
    let streamError: unknown;
    const appended: unknown[] = [];
    globals.window = {
      addEventListener: (name: string, listener: (event: { persisted: boolean }) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    const kind = app === "sheets" ? "xlsx" : "pptx";
    globals.__hostRegression = {
      OfficeSessionQueue, OrderedChatAppender, officeStreamFailure,
      platformFetch: async () => { throw streamError; },
      appendOfficeChatFn: async (request: unknown) => { appended.push(request); },
      openEngineSessionFn: async ({ data }: { data: { docId: string } }) => ({
        engineUrl: "http://127.0.0.1:9999", token: "synthetic", tokenExpiresAt: Date.now() + 900_000,
        document: { docId: data.docId, kind, name: `${data.docId}.${kind}`, version: 1, hash: "hash" }, source: "synthetic",
      }),
      emitHost: (...args: unknown[]) => { events.push(args); },
      installHost: (handler: typeof invoke) => { invoke = handler; },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body, signal: init?.signal ?? undefined });
      if (url.endsWith("/open")) return Response.json({ sessionId: `session-${body.docId}`, sequence: 0, result: null });
      if (url.endsWith("/close")) return Response.json({ ok: true });
      if (url.includes("session-A/rpc")) { started.resolve(); return gate.promise; }
      return Response.json({ sequence: 1, operationKind: "write", result: "new result", events: [] });
    };
    try {
      // Transform the complete production host, replacing only imported external services.
      const source = await readFile(new URL(`../../office/${app}/web/host/session.ts`, import.meta.url), "utf8");
      const stripped = (await transform(source, { loader: "ts", format: "esm", target: "es2022" })).code
        .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, "");
      const js = "const { OfficeSessionQueue, OrderedChatAppender, officeStreamFailure, platformFetch, appendOfficeChatFn, openEngineSessionFn, emitHost, installHost } = globalThis.__hostRegression;\n" + stripped;
      const host = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
      const a = new AbortController();
      await host.initialize({ docId: "A", navigateTo: () => undefined }, a.signal);
      const first = host.rpc("write", [{ text: "old" }]);
      const rejected = assert.rejects(first, /session changed/);
      await started.promise;
      const queued = host.rpc("write", [{ text: "queued old" }]);
      const queuedRejected = assert.rejects(queued, /session changed/);
      const b = new AbortController();
      await host.initialize({ docId: "B", navigateTo: () => undefined }, b.signal);
      // A delayed old route cleanup cannot invalidate B.
      await host.teardown(a.signal);
      assert.equal(await host.rpc("write", [{ text: "new" }]), "new result");
      gate.resolve(Response.json({ sequence: 99, document: { draftId: "A" }, events: [{ channel: "old-event", args: [] }] }));
      await Promise.all([rejected, queuedRejected]);
      assert.equal(host.currentState().document.draftId, "B");
      assert.equal(host.currentState().sequence, 1);
      assert.equal(events.length, 0);
      const rpcs = requests.filter(r => r.url.endsWith("/rpc"));
      assert.equal(rpcs.length, 2);
      assert.equal(rpcs[0].signal?.aborted, true);
      assert.deepEqual(rpcs[1].body.args, [{ text: "new" }]);
      // A failed old run can finish after B opens. Its explicit chat identity must
      // never be silently retargeted to the currently active document.
      await assert.rejects(invoke("project:appendChat", [{ projectId: "A", chatId: "A", role: "assistant", text: "old checkpoint" }]), /session changed/);
      assert.equal(appended.length, 0);
      await invoke("project:appendChat", [{ projectId: "B", chatId: "B", role: "assistant", text: "current checkpoint" }]);
      assert.equal(appended.length, 1);
      assert.equal((appended[0] as { data: { docId: string } }).data.docId, "B");
      // Exercise the complete host stream catch, not only the classifier helper.
      for (const [error, expectedCode] of [
        [Object.assign(new Error("private upstream payload"), { status: 503 }), "network"],
        [new TypeError("Failed to fetch"), "network"],
        [Object.assign(new Error("private auth details"), { status: 401 }), undefined],
      ] as const) {
        streamError = error;
        await invoke("ai:stream", [{ requestId: "stream-check", system: "fixture", messages: [] }]);
        const event = (events.at(-1) as [string, { type: string; error: string; errorCode?: string }])[1];
        assert.equal(event.type, "error");
        assert.equal(event.errorCode, expectedCode);
        assert.doesNotMatch(event.error, /private|payload|auth details/);
        assert.equal(host.currentState().busy, false);
      }
      listeners.get("pagehide")?.({ persisted: true });
      assert.equal(host.currentState().document.draftId, "B", "bfcache keeps its live document");
      listeners.get("pagehide")?.({ persisted: false });
      assert.equal(listeners.has("pagehide"), false);
      assert.ok(requests.some(request => request.url.endsWith("session-B/close")), "closing a tab releases its engine worker");
      await assert.rejects(host.rpc("write"), /not open/);
    } finally {
      globalThis.fetch = previousFetch;
      globals.window = previousWindow;
      delete globals.__hostRegression;
    }
  });
}
