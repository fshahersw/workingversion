import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamWriterTurn, type AgentToolCall } from './inference.server';

// Actual AWS binary framing + production Office parser; signing/network is the
// only injected seam. Nothing calls AWS or requires credentials.
function frame(event: unknown): Uint8Array {
  const payload = new TextEncoder().encode(typeof event === 'string' ? event : JSON.stringify(event));
  const bytes = new Uint8Array(payload.length + 16);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(payload, 12);
  return bytes;
}
const start = (index = 0, id = 'tool-1', name = 'read_cells') => ({ contentBlockIndex: index, start: { toolUse: { toolUseId: id, name } } });
const input = (index = 0, json = '{"addresses":["A1"]}') => ({ contentBlockIndex: index, delta: { toolUse: { input: json } } });
const close = (index = 0) => ({ contentBlockIndex: index });
const stop = (stopReason = 'tool_use') => ({ stopReason });
const completeTool = () => [start(), input(), close(), stop()];
async function run(events: unknown[], options: { signal?: AbortSignal; tail?: Uint8Array; onEnd?: () => void } = {}) {
  const calls: AgentToolCall[] = [], stops: string[] = [], texts: string[] = [];
  let requests = 0;
  const bytes = Buffer.concat([...events.map(frame), ...(options.tail ? [options.tail] : [])]);
  const promise = streamWriterTurn({ app: 'sheets', profile: 'standard', system: 'Synthetic parser regression',
    messages: [{ role: 'user', text: 'Read cell A1.' }], tools: [{ name: 'read_cells', description: 'Read only', inputSchema: { type: 'object' } }],
    model: 'us.anthropic.claude-sonnet-5', signal: options.signal ?? new AbortController().signal,
    bedrockFetch: async (url, request) => {
      requests++;
      assert.match(url, /^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com\/model\/.*\/converse-stream$/);
      const sent = JSON.parse(request.body);
      assert.equal(sent.toolConfig.tools[0].toolSpec.name, 'read_cells');
      let at = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (at === bytes.length) { options.onEnd?.(); controller.close(); return; }
        // Split headers and JSON across reads to exercise actual framing.
        const end = Math.min(bytes.length, at + 31); controller.enqueue(bytes.subarray(at, end)); at = end;
      } }));
    },
  }, { onDelta: text => texts.push(text), onReasoning: () => {}, onStopReason: reason => stops.push(reason), onToolCall: call => calls.push(call) });
  try { await promise; return { calls, stops, texts, requests, error: undefined }; }
  catch (error) { return { calls, stops, texts, requests, error }; }
}

test('production Bedrock completes valid independent tools in order, with fragmented frames', async () => {
  const result = await run([start(), input(), close(), start(1, 'tool-2'), input(1), close(1), stop()]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.map(c => c.id), ['tool-1', 'tool-2']);
  assert.deepEqual(result.calls[0].input, { addresses: ['A1'] });
  assert.equal(result.requests, 1);
});

for (const [name, events, tail] of [
  ['end_turn with tool proposals', [start(), input(), close(), stop('end_turn')]],
  ['guardrail/refusal with proposals', [start(), input(), close(), stop('guardrail_intervened')]],
  ['missing block stop', [start(), input(), stop()]],
  ['duplicate IDs', [start(), input(), close(), start(1), input(1), close(1), stop()]],
  ['duplicate block index', [start(), start(0, 'tool-2'), input(), close(), stop()]],
  ['arguments after closed block', [start(), input(), close(), input(), stop()]],
  ['orphan arguments', [input(), stop()]],
  ['non-string tool argument fragment', [start(), { contentBlockIndex: 0, delta: { toolUse: { input: 7 } } }, close(), stop()]],
  ['malformed JSON event', [start(), input(), '{', close(), stop()]],
  ['no message stop', [start(), input(), close()]],
  ['trailing partial frame', completeTool(), new Uint8Array([0, 1, 2])],
  ['malformed frame', completeTool(), new Uint8Array(16)],
  ['content after stop', [start(), input(), close(), stop(), start(1, 'tool-2')]],
  ['tool stop without tools', [stop()]],
] as const) test(`production Bedrock rejects ${name} before dispatching any tool`, async () => {
  const result = await run([...events], tail ? { tail } : {});
  assert.ok(result.error); assert.deepEqual(result.calls, []);
});

test('confirmed Bedrock output limit makes the entire tool batch unexecutable', async () => {
  const result = await run([start(), input(), close(), start(1, 'tool-2'), input(1, '{'), stop('max_tokens')]);
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(call => call.truncated));
});

test('Bedrock complete malformed arguments and disallowed tools become repairable tool errors', async () => {
  const result = await run([start(), input(0, '{'), close(), start(1, 'tool-2', 'run_python'), input(1), close(1), stop()]);
  assert.equal(result.error, undefined);
  assert.ok(result.calls.every(call => call.inputError));
});

test('abort while EOF arrives cannot dispatch an otherwise completed Bedrock tool batch', async () => {
  const controller = new AbortController();
  const result = await run(completeTool(), { signal: controller.signal, onEnd: () => controller.abort() });
  assert.equal((result.error as Error).name, 'AbortError');
  assert.deepEqual(result.calls, []);
});

test('text-only Bedrock end turns remain supported', async () => {
  const result = await run([{ contentBlockIndex: 0, delta: { text: 'Read complete.' } }, close(), stop('end_turn')]);
  assert.equal(result.error, undefined); assert.deepEqual(result.calls, []);
  assert.deepEqual(result.texts, ['Read complete.']);
});

test('abort while consuming a retryable Bedrock response prevents backoff and another request', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(streamWriterTurn({ profile: 'standard', system: 'Synthetic retry test', messages: [], tools: [],
    model: 'us.anthropic.claude-sonnet-5', signal: controller.signal,
    bedrockFetch: async () => {
      requests++;
      return { ok: false, status: 503, headers: new Headers(), text: async () => { controller.abort(); return '{}'; } } as Response;
    },
  }, { onDelta: () => {}, onReasoning: () => {}, onStopReason: () => {}, onToolCall: () => assert.fail('No tools') }), { name: 'AbortError' });
  assert.equal(requests, 1);
});
