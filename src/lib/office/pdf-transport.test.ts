import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfTransport } from "../../office/pdf/transport";

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
