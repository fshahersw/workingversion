import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, OPAQUE_REASONING_PREFIX } from './loop';
import { createIpcTransport } from './electron-transport';
import type { AgentLoopOptions } from './loop';
import type { AgentMessage, AgentStreamCallbacks, AgentStreamRequest, AgentToolCall, AgentTransport } from './types';

const call = (id: string, name = 'read', input: Record<string, unknown> = {}): AgentToolCall => ({ id, name, input });
type Step = (cb: AgentStreamCallbacks, request: AgentStreamRequest) => void;
function harness(steps: Step[], options: Partial<AgentLoopOptions<string>> = {}) {
  const requests: AgentStreamRequest[] = [], actions: string[] = [];
  let resolve!: (value: { error?: string; done?: unknown }) => void;
  let cancelCalls = 0;
  const transport: AgentTransport = { stream(request, callbacks) {
    requests.push(structuredClone(request));
    const step = steps.shift();
    if (!step) throw new Error('Unexpected model round');
    queueMicrotask(() => step(callbacks, request));
    return { cancel() { cancelCalls++; callbacks.onDone(); } };
  } };
  const loop = new AgentLoop<string>({
    transport, transientRetryDelaysMs: [0, 0],
    skill: { id: 'fixture', systemPrompt: 'Synthetic local test.',
      tools: [{ name: 'read', description: 'read', inputSchema: {}, readOnly: true },
        { name: 'write', description: 'write', inputSchema: {} }],
      executeTool(tool) {
        actions.push(`${tool.name}:${tool.id}`);
        return { output: tool.name === 'read' ? `Source https://example.test/earnings; revenue ${tool.input.quarter ?? 0}` : 'Edited selected cells', summary: tool.name, mutated: tool.name === 'write' };
      },
    },
    ...options,
    events: { ...options.events,
      onError(error) { options.events?.onError?.(error); resolve({ error }); },
      onDone(done) { options.events?.onDone?.(done); resolve({ done }); },
    },
  });
  return { loop, requests, actions, get cancelCalls() { return cancelCalls; },
    run(instruction: string) {
      const result = new Promise<{ error?: string; done?: unknown }>(res => { resolve = res; });
      loop.run(instruction); return result;
    },
  };
}
const tools = (...calls: AgentToolCall[]): Step => cb => { calls.forEach(tool => cb.onToolCall(tool)); cb.onDone(); };
const answer = (text = 'Finished.'): Step => cb => { cb.onDelta(text); cb.onDone(); };

test('an unsupported completion claim after one corrective turn is replaced and marked unverified', async () => {
  const h=harness([answer('Invented download one'),answer('Invented download two')],{skill:{id:'receipt-check',systemPrompt:'Use real receipts.',tools:[],executeTool:()=>{throw new Error('unused');},verifyResponse:()=> 'No file receipt exists. Perform the operation or state the limitation.'}});
  const result=await h.run('Export the PDF');
  assert.equal(h.requests.length,2);assert.equal((result.done as {unverified?:boolean}).unverified,true);
  assert.match((result.done as {text:string}).text,/could not be verified/);
  assert.ok(!(result.done as {text:string}).text.includes('Invented download'));
  assert.equal(h.loop.taskStatus().state,'partial');
});
function assertPairs(messages: readonly AgentMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const next = messages[index + 1];
      assert.equal(next?.role, 'tool');
      if (next?.role === 'tool') assert.deepEqual(next.results.map(result => result.id), message.toolCalls.map(tool => tool.id));
    }
    if (message.role === 'tool') assert.equal(messages[index - 1]?.role, 'assistant');
  }
}

test('failed long research retains the exact task and sourced results for explicit continue', async () => {
  const instruction = 'Create a mock quarterly Tesla income statement for five years, label all estimates, style it and verify formulas.';
  const h = harness([
    ...Array.from({ length: 15 }, (_, i) => tools(call(String(i), 'read', { quarter: i }))),
    cb => cb.onError('The service failed', { retryable: false }),
    (cb, request) => {
      const transcript = JSON.stringify(request.messages);
      assert.ok(transcript.includes(instruction));
      assert.ok(transcript.includes('https://example.test/earnings'));
      assert.ok(transcript.includes('Task interrupted'));
      assert.ok(transcript.includes('Do not replay prior writes automatically'));
      assert.equal(request.messages.at(-1)?.role, 'user');
      assertPairs(request.messages);
      cb.onToolCall(call('inspect', 'read')); cb.onDone();
    }, tools(call('create', 'write')), answer(),
  ], { compaction: false, maxTurns: 120 });
  assert.ok((await h.run(instruction)).error);
  assert.equal(h.loop.busy, false);
  assert.match(h.loop.failureCheckpoint!, /No tool reported a completed artifact edit/);
  assert.ok((await h.run('continue')).done);
  assert.deepEqual(h.actions.slice(-2), ['read:inspect', 'write:create']);
  assert.equal(h.actions.filter(action => action.startsWith('write:')).length, 1);
});

test('failed mutation checkpoint marks rollback state unknown and survives paired restore', async () => {
  const h = harness([tools(call('edit', 'write')), cb => cb.onError('Connection gone', { retryable: false })]);
  await h.run('Create a formal report, then verify it.');
  assert.match(h.loop.failureCheckpoint!, /current application status is unknown/);
  assert.match(h.loop.failureCheckpoint!, /inspect current artifact state/);
  const resumed = harness([(cb, request) => {
    assert.match(JSON.stringify(request.messages), /Create a formal report/);
    assert.match(JSON.stringify(request.messages), /current application status is unknown/);
    cb.onDelta('I will inspect before proceeding.'); cb.onDone();
  }]);
  resumed.loop.restore([{ role: 'user', text: 'Create a formal report, then verify it.' },
    { role: 'assistant', text: h.loop.failureCheckpoint! }]);
  await resumed.run('continue');
  assert.deepEqual(resumed.actions, []);
  resumed.loop.reset();
  assert.equal(resumed.loop.failureCheckpoint, null);
  assert.deepEqual(resumed.loop.messages, []);
});

test('transient model retry discards streamed proposals and never replays completed edits', async () => {
  const h = harness([
    tools(call('first', 'write')),
    cb => { cb.onDelta('Unfinished prose'); cb.onToolCall(call('discarded', 'write')); cb.onError('temporary network error', { code: 'network', retryable: true }); },
    (cb, request) => {
      assert.ok(!JSON.stringify(request.messages).includes('discarded'));
      assertPairs(request.messages);
      cb.onToolCall(call('second', 'write')); cb.onDone();
    }, answer(),
  ]);
  assert.ok((await h.run('Write two sections.')).done);
  assert.deepEqual(h.actions, ['write:first', 'write:second']);
  assert.equal(h.requests.length, 4);
});

test('transient retries are bounded and explicit nonretryable metadata wins over error prose', async () => {
  let attempts = 0;
  const error: Step = cb => { attempts++; cb.onError('Service unavailable', { code: 'overloaded', retryable: true }); };
  const h = harness([error, error, error, answer()]);
  assert.ok((await h.run('Research')).error);
  assert.equal(attempts, 3); assert.equal(h.requests.length, 3);
  const permanent = harness([cb => cb.onError('HTTP 503 in an invalid request example', { code: 'validation', retryable: false })]);
  assert.ok((await permanent.run('Research')).error);
  assert.equal(permanent.requests.length, 1);
});

test('zero-tool token exhaustion reports partial without claiming a completed outcome', async () => {
  for (const prose of ['', 'A cut-off paragraph']) {
    const h = harness([cb => {
      cb.onReasoning?.('Synthetic reasoning only');
      if (prose) cb.onDelta(prose);
      cb.onStopReason?.('max_tokens'); cb.onDone();
    }]);
    const result = await h.run('Create the full quarterly workbook.');
    assert.equal((result.done as { truncated?: boolean }).truncated, true);
    assert.equal(h.loop.taskStatus().state, 'partial');
    assert.equal(h.loop.busy, false);
    assert.deepEqual(h.actions, []);
    if (!prose) {
      assert.match(JSON.stringify(h.loop.messages), /task is incomplete/);
      assert.doesNotMatch(JSON.stringify(h.loop.messages), /completed tool actions/);
    }
  }
});

test('a 502 then 400 never retains partial text, reasoning, tool proposals or late callbacks in retry history', async () => {
  let failedCallbacks!: AgentStreamCallbacks;
  const h = harness([
    tools(call('completed', 'read')),
    cb => {
      failedCallbacks = cb;
      cb.onDelta('DISCARDED partial prose');
      cb.onReasoning?.(OPAQUE_REASONING_PREFIX + 'DISCARDED signed reasoning');
      cb.onReasoning?.('DISCARDED readable reasoning');
      cb.onToolCall({ ...call('DISCARDED-partial', 'write'), inputError: 'unfinished JSON' });
      cb.onStopReason?.('tool_use');
      cb.onError('HTTP 502', { code: 'network', retryable: true });
    },
    (cb, request) => {
      failedCallbacks.onDelta('DISCARDED late text');
      failedCallbacks.onToolCall(call('DISCARDED-late', 'write'));
      failedCallbacks.onDone();
      assert.deepEqual(request.messages, h.requests[1]!.messages);
      assert.doesNotMatch(JSON.stringify(request), /DISCARDED/);
      assertPairs(request.messages);
      cb.onError('HTTP 400 invalid request', { retryable: false });
    },
  ]);
  assert.match((await h.run('Continue the verified table.')).error!, /400/);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.actions, ['read:completed']);
  assert.doesNotMatch(JSON.stringify(h.loop.messages), /DISCARDED/);
  assertPairs(h.loop.messages);
});

test('queued directions label deliberately unexecuted calls skipped while preserving an error result to the model', async () => {
  const activity: Array<{ id: string; skipped?: boolean; isError?: boolean }> = [];
  const h = harness([
    tools(call('read-before-steer'), call('obsolete-write', 'write')),
    (cb, request) => {
      const result = request.messages.flatMap(message => message.role === 'tool' ? message.results : []).find(result => result.id === 'obsolete-write');
      assert.equal(result?.isError, true);
      assert.match(result?.output ?? '', /Not executed/);
      assert.equal('skipped' in result!, false, 'UI status must not alter the provider transcript');
      cb.onToolCall(call('replanned-write', 'write')); cb.onDone();
    }, answer(),
  ], { events: { onToolExecuted: ({ call: tool, execution }) => {
    activity.push({ id: tool.id, skipped: execution.skipped, isError: execution.isError });
    if (tool.id === 'read-before-steer') h.loop.steer('Use mock numbers only.');
  } } });
  assert.ok((await h.run('Build the quarterly table.')).done);
  assert.deepEqual(h.actions, ['read:read-before-steer', 'write:replanned-write']);
  assert.deepEqual(activity.find(item => item.id === 'obsolete-write'), { id: 'obsolete-write', skipped: true, isError: true });
  assert.equal(activity.find(item => item.id === 'replanned-write')?.skipped, undefined);
});

test('three truncated calls in one response get a repair turn without executing partial edits', async () => {
  const h = harness([
    tools(...['a', 'b', 'c'].map(id => ({ ...call(id, 'write'), inputError: 'truncated', truncated: true }))),
    tools(call('repaired', 'write')), answer(),
  ]);
  assert.ok((await h.run('Create and format a table.')).done);
  assert.deepEqual(h.actions, ['write:repaired']);
  assertPairs(h.requests[1]!.messages);
  assert.equal(h.requests[1]!.messages.filter(m => m.role === 'tool').at(-1)?.role, 'tool');
});

test('three unusable repair rounds stop with a resumable checkpoint', async () => {
  const malformed = (id: string) => tools({ ...call(id, 'write'), inputError: 'Invalid JSON' });
  const h = harness([malformed('a'), malformed('b'), malformed('c'), answer()]);
  const result = await h.run('Create a table.');
  assert.match(result.error!, /3 repair rounds/);
  assert.equal(h.requests.length, 3); assert.deepEqual(h.actions, []);
  assertPairs(h.loop.messages); assert.match(h.loop.failureCheckpoint!, /interrupted/);
});

test('active-run compaction bounds old arguments/reasoning and retains goal, source and steering across 45 rounds', async () => {
  const instruction = 'Use mock data only; build 20 quarters, native formulas and charts, then verify.';
  let largest = 0, compacted = 0;
  const h = harness([
    ...Array.from({ length: 45 }, (_, quarter): Step => (cb, request) => {
      const serialized = JSON.stringify(request.messages);
      largest = Math.max(largest, serialized.length);
      assert.ok(serialized.includes(instruction)); assertPairs(request.messages);
      if (quarter > 2) assert.ok(serialized.includes('Keep amounts in USD millions.'));
      if (quarter > 8) assert.ok(serialized.includes('https://example.test/earnings'));
      cb.onReasoning?.(OPAQUE_REASONING_PREFIX + 'opaque'.repeat(500));
      cb.onToolCall(call(String(quarter), 'read', { quarter, selection: 'A'.repeat(2_000) }));
      cb.onDone();
    }), answer(),
  ], {
    maxTurns: 60, compaction: { maxBytes: 14_000, keepRecentBytes: 6_000, disableLlmSummary: true },
    events: {
      onToolExecuted: ({ call: tool }) => { if (tool.id === '1') assert.equal(h.loop.steer('Keep amounts in USD millions.').accepted, true); },
      onStatus: status => { if (status.text.startsWith('Compacted')) compacted++; },
    },
  });
  assert.ok((await h.run(instruction)).done);
  assert.equal(h.actions.length, 45); assert.ok(compacted > 3);
  assert.ok(largest < 19_000, `Maximum serialized request: ${largest}`);
  assertPairs(h.loop.messages);
});

test('default byte budget compacts repeated long runs while retaining the current goal and complete pairs', async () => {
  let largest = 0, compacted = 0;
  const rounds = (goal: string, count: number): Step[] => Array.from({ length: count }, (_, index) => (cb, request) => {
    const serialized = JSON.stringify(request.messages);
    largest = Math.max(largest, new TextEncoder().encode(serialized).byteLength);
    assert.ok(serialized.includes(goal));
    assertPairs(request.messages);
    cb.onReasoning?.(OPAQUE_REASONING_PREFIX + 'signed-fixture'.repeat(700));
    cb.onToolCall(call(`${goal}-${index}`, 'read', { quarter: index, financialRows: '12345,67890,'.repeat(1400) }));
    cb.onDone();
  });
  const first = 'Build 20 mock quarters and verify all calculations.';
  const second = 'Keep the verified quarters and improve the native charts.';
  const h = harness([...rounds(first, 40), answer(), ...rounds(second, 30), answer()], {
    // No budget overrides: exercise production defaults across two user runs.
    compaction: { disableLlmSummary: true },
    events: { onStatus(status) { if (status.text.startsWith('Compacted')) compacted++; } },
  });
  assert.ok((await h.run(first)).done);
  assert.ok((await h.run(second)).done);
  assert.equal(h.actions.length, 70);
  assert.ok(compacted >= 4, `Compaction count: ${compacted}`);
  assert.ok(largest < 300_000, `Maximum serialized history bytes: ${largest}`);
  assertPairs(h.loop.messages);
});

test('synchronous transport and snapshot failures settle busy state with valid recovery history', async () => {
  const h = harness([], { transport: { stream() { throw new Error('Transport unavailable'); } } });
  assert.match((await h.run('Research a report.')).error!, /Transport unavailable/);
  assert.equal(h.loop.busy, false); assert.match(h.loop.failureCheckpoint!, /interrupted/);
  const snapshot = harness([tools(call('write', 'write'))], { captureSnapshot() { throw new Error('Snapshot unavailable'); } });
  assert.match((await snapshot.run('Write a report.')).error!, /Snapshot unavailable/);
  assert.equal(snapshot.loop.busy, false); assert.deepEqual(snapshot.actions, []);
  assertPairs(snapshot.loop.messages);
});

test('cancel during backoff settles immediately and reset cannot start a delayed retry in the next document', async () => {
  const h = harness([cb => cb.onError('retry', { retryable: true }), answer()], {
    transientRetryDelaysMs: [30_000],
    events: { onStatus(status) { if (status.text.includes('retrying')) queueMicrotask(() => h.loop.cancel()); } },
  });
  const result = await h.run('Research');
  assert.equal((result.done as any).cancelled, true); assert.equal(h.loop.busy, false);
  assert.equal(h.requests.length, 1);
  h.loop.reset();
  assert.ok((await h.run('Different document')).done);
  assert.equal(h.requests.length, 2);
});

test('IPC forwards typed retryability even when the user-facing message is localized', async () => {
  let listener!: (chunk: any) => void;
  let metadata: unknown;
  const transport = createIpcTransport({
    onStream(fn) { listener = fn; return () => undefined; },
    start(request) { queueMicrotask(() => listener({ requestId: request.requestId, type: 'error', errorCode: 'overloaded' })); },
    cancel() {}, getSettings: () => ({}), unknownErrorText: () => 'Unknown', overloadedErrorText: () => 'Inténtalo de nuevo',
  });
  await new Promise<void>(resolve => transport.stream({ system: '', messages: [], tools: [] }, {
    onDelta() {}, onToolCall() {}, onDone() {}, onError(error, details) {
      assert.equal(error, 'Inténtalo de nuevo'); metadata = details; resolve();
    },
  }));
  assert.deepEqual(metadata, { code: 'overloaded', retryable: true });
});

test('failed finalizing request cannot leave a no-tools directive that poisons explicit continuation', async () => {
  const h = harness([tools(call('first')), cb => cb.onError('Cannot summarize', { retryable: false }),
    (cb, request) => {
      assert.ok(request.tools.length > 0);
      assert.ok(!JSON.stringify(request.messages).includes('no more tools may be called this turn'));
      cb.onDelta('Resuming the saved task.'); cb.onDone();
    }], { maxTurns: 1 });
  assert.ok((await h.run('Research and create a workbook.')).error);
  assert.ok((await h.run('continue')).done);
});

test('reset while a tool is in flight prevents its late completion from contaminating a new task', async () => {
  let finishTool!: () => void, started!: () => void;
  const toolStarted = new Promise<void>(resolve => { started = resolve; });
  const h = harness([tools(call('old', 'write')), answer('New task response')], {
    skill: { id: 'fixture', systemPrompt: '', tools: [{ name: 'write', description: '', inputSchema: {} }],
      async executeTool() { started(); await new Promise<void>(resolve => { finishTool = resolve; }); return { output: 'old result', summary: 'old', mutated: true }; },
    },
  });
  void h.run('Old task'); await toolStarted;
  h.loop.reset();
  await h.run('New task');
  finishTool(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.requests.length, 2);
  assert.ok(!JSON.stringify(h.loop.messages).includes('old result'));
  assert.ok(!JSON.stringify(h.loop.messages).includes('Old task'));
  assert.equal(h.loop.taskStatus().state, 'completed');
});
