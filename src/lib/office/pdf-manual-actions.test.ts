import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { transform } from 'esbuild';

/** Execute the actual workspace callbacks with asynchronous dependencies
 * controlled by the test. Stale React state deliberately remains unchanged
 * so only the synchronous refs can prevent same-tick collisions. */
async function callbacks(context: Record<string, unknown>) {
  const source = await readFile(new URL('../../office/pdf/PdfWorkspace.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('PdfWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ['apply', 'send', 'save', 'download'].includes(node.name.getText(tree)) && node.initializer) {
      declarations.set(node.name.getText(tree), `const ${node.name.getText(tree)} = ${node.initializer.getText(tree)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.equal(declarations.size, 4);
  const code = (await transform([...declarations.values()].join('\n'), { loader: 'ts' })).code;
  return new Function('context', `const {${Object.keys(context).join(',')}}=context; ${code}; return {apply,send,save,download};`)(context) as {
    apply: (operations: unknown[], description: string) => Promise<boolean>;
    send: (instruction?: string) => Promise<void>;
    save: () => Promise<void>;
    download: () => Promise<void>;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const mutation = deferred<Uint8Array>(), write = deferred<Response>();
  const manualBusy = { current: false }, busyRef = { current: false }, alive = { current: true };
  const initial = { bytes: new Uint8Array([1]) as Uint8Array, revision: 3, meta: { version: 5, name: 'synthetic.pdf' }, dirty: true };
  const model = { current: initial };
  const calls = { mutations: 0, installs: 0, saves: 0, runs: 0, appends: 0, cleared: 0 };
  const noop = () => {};
  const downloads: Array<{ version?: number; bytes?: Uint8Array; name: string }> = [];
  const api = await callbacks({
    locked: false, busy: false, saving: false, dirty: true, manualBusy, busyRef, alive,
    current: () => model.current, model, saveAttempt: { current: null }, docId: 'synthetic-pdf', prompt: 'Inspect this page',
    applyPdfOperations: async () => { calls.mutations++; return mutation.promise; },
    install: async (bytes: Uint8Array, revision: number) => {
      calls.installs++; assert.equal(revision, 3); model.current = { ...model.current, bytes, revision: revision + 1 };
    },
    transferOfficeRevision: async () => { calls.saves++; return (await write.promise).json(); },
    loop: { current: { run: () => { calls.runs++; } } }, directions: { current: null },
    runStart: { current: null }, followConversation: { current: false },
    append: async () => { calls.appends++; },
    setPrompt: () => { calls.cleared++; }, setError: noop, setSaving: noop, setBusy: noop,
    setActivity: noop, setMeta: noop, setDirty: noop, setNotice: noop,
    messageOf: (error: Error) => error.message,
    downloadSavedPdf: (_docId: string, version: number, name: string) => downloads.push({version,name}),
    downloadPdf: (bytes: Uint8Array, name: string) => downloads.push({bytes,name}),
  });
  return { api, calls, mutation, write, manualBusy, busyRef, model, alive, downloads };
}

test('PDF actual manual apply blocks a second click, Save and agent send before any rerender', async () => {
  const f = await fixture();
  const first = f.api.apply([{ type: 'rotate_pages', pages: [1], degrees: 90 }], 'Rotate');
  assert.equal(f.manualBusy.current, true);
  assert.equal(await f.api.apply([], 'Second click'), false);
  await f.api.save(); await f.api.send();
  assert.deepEqual(f.calls, { mutations: 1, installs: 0, saves: 0, runs: 0, appends: 0, cleared: 0 });
  f.mutation.resolve(new Uint8Array([2]));
  assert.equal(await first, true);
  assert.equal(f.calls.installs, 1); assert.equal(f.manualBusy.current, false);
});

test('PDF actual save blocks a manual edit and agent send until persistence settles', async () => {
  const f = await fixture();
  const saving = f.api.save(); assert.equal(f.manualBusy.current, true);
  assert.equal(await f.api.apply([], 'During save'), false); await f.api.send(); await f.api.save();
  assert.deepEqual(f.calls, { mutations: 0, installs: 0, saves: 1, runs: 0, appends: 0, cleared: 0 });
  f.write.resolve(Response.json({ version: 6 })); await saving;
  assert.equal(f.manualBusy.current, false); assert.equal(f.model.current.meta.version, 6);
});

test('PDF actual agent send blocks manual edit and save synchronously', async () => {
  const f = await fixture(); await f.api.send();
  assert.equal(f.busyRef.current, true);
  assert.equal(await f.api.apply([], 'During agent'), false); await f.api.save();
  assert.deepEqual(f.calls, { mutations: 0, installs: 0, saves: 0, runs: 1, appends: 1, cleared: 1 });
});

test('PDF actual failed manual edit releases its lock without installing partial bytes', async () => {
  const f = await fixture(); const pending = f.api.apply([], 'Will fail');
  f.mutation.reject(new Error('Synthetic validation failure'));
  assert.equal(await pending, false); assert.equal(f.manualBusy.current, false);
  assert.equal(f.calls.installs, 0); assert.equal(f.model.current.revision, 3);
});

test('PDF download saves dirty bytes first and uses the returned server revision', async () => {
  const f = await fixture(); const pending = f.api.download();
  assert.equal(f.calls.saves, 1); assert.equal(f.downloads.length, 0);
  await f.api.download(); assert.equal(f.calls.saves, 1);
  f.write.resolve(Response.json({version:6,name:'synthetic.pdf'})); await pending;
  assert.deepEqual(f.downloads,[{version:6,name:'synthetic.pdf'}]);
});

test('PDF saved download avoids writes and uses the current revision', async () => {
  const f = await fixture(); f.model.current.dirty = false; await f.api.download();
  assert.equal(f.calls.saves,0); assert.deepEqual(f.downloads,[{version:5,name:'synthetic.pdf'}]);
});

test('PDF failed save offers current recovery bytes and never an outdated server download', async () => {
  const f = await fixture(); const pending = f.api.download();
  f.write.reject(new Error('Synthetic storage outage')); await pending;
  assert.deepEqual(f.downloads,[{bytes:f.model.current.bytes,name:'synthetic-recovery.pdf'}]);
  assert.equal(f.model.current.dirty,true);
});

test('PDF download does not leak a completion into a closed workspace', async () => {
  const f = await fixture(); const pending = f.api.download(); f.alive.current=false;
  f.write.resolve(Response.json({version:6,name:'synthetic.pdf'})); await pending;
  assert.equal(f.downloads.length,0);
});
