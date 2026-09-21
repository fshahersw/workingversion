import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfTransport } from "../../office/pdf/transport";

test('PDF transport reads the current mode and profile on each model request', async () => {
  const previousFetch = globalThis.fetch;
  let mode: 'write' | 'ask' | 'review' = 'ask';
  let profile: 'standard' | 'thorough' = 'thorough';
  const sent: Array<Record<string, unknown>> = [];
  const transport = pdfTransport({ mode: () => mode, profile: () => profile });
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/office/stream');
      assert.equal(init?.credentials, 'same-origin');
      const body = JSON.parse(String(init?.body)); sent.push(body);
      return new Response(`data: ${JSON.stringify({ requestId: body.requestId, type: 'done', stopReason: 'end_turn' })}\n\n`);
    };
    const request = { system: 'PDF fixture', messages: [{ role: 'user' as const, text: 'Read page 1.' }], tools: [] };
    const invoke = () => new Promise<void>((resolve, reject) => {
      transport.stream(request, { onDelta: () => {}, onToolCall: () => {}, onDone: resolve, onError: reject });
    });
    await invoke();
    mode = 'review'; profile = 'standard'; await invoke();
    mode = 'write'; profile = 'thorough'; await invoke();
    assert.deepEqual(sent.map(body => [body.app, body.mode, body.profile]), [
      ['pdf', 'ask', 'thorough'], ['pdf', 'review', 'standard'], ['pdf', 'write', 'thorough'],
    ]);
    assert.equal(new Set(sent.map(body => body.requestId)).size, 3);
    assert.ok(sent.every(body => JSON.stringify(body.messages) === JSON.stringify(request.messages)));
  } finally { globalThis.fetch = previousFetch; }
});

test("PDF transport preserves retry classification and cannot turn an error into successful completion", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const code of ["overloaded", "network", "timeout", "credits"]) {
      globalThis.fetch = async (_url, init) => {
        const { requestId } = JSON.parse(String(init?.body));
        return new Response(`data: ${JSON.stringify({ requestId, type: "error", error: "Synthetic failure", errorCode: code })}\n\n`);
      };
      await new Promise<void>((resolve, reject) => {
        pdfTransport().stream({ system: "fixture", messages: [{ role: "user", text: "Read fixture" }], tools: [] }, {
          onDelta: () => reject(new Error("unexpected delta")),
          onToolCall: () => reject(new Error("unexpected tool")),
          onDone: () => reject(new Error("an error must not complete the run")),
          onError: (message, metadata) => {
            assert.equal(message, "Synthetic failure");
            assert.equal(metadata?.code, code);
            assert.equal(metadata?.retryable, code !== "credits");
            resolve();
          },
        });
      });
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("PDF transport classifies HTTP and interrupted-stream failures without exposing upstream bodies", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const [status, expectedCode] of [[503, "network"], [429, "overloaded"], [504, "timeout"], [401, undefined], [422, undefined], [200, "network"]] as const) {
      globalThis.fetch = async () => status === 200
        ? new Response("")
        : Response.json({ error: "private upstream detail" }, { status });
      await new Promise<void>((resolve, reject) => {
        pdfTransport().stream({ system: "fixture", messages: [{ role: "user", text: "Read fixture" }], tools: [] }, {
          onDelta: () => reject(new Error("unexpected delta")),
          onToolCall: () => reject(new Error("unexpected tool")),
          onDone: () => reject(new Error("failed HTTP or incomplete stream must not complete")),
          onError: (message, metadata) => {
            try {
              assert.doesNotMatch(message, /private upstream/);
              assert.equal(metadata?.code, expectedCode);
              assert.equal(metadata?.retryable, Boolean(expectedCode));
              resolve();
            } catch (error) { reject(error); }
          },
        });
      });
    }
  } finally { globalThis.fetch = previousFetch; }
});
