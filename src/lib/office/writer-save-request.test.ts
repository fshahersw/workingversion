import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriterSaveCoordinator } from '../../writer/platform/save-request';

function fixture(timeoutMs = 1000, failRequest = false) {
  const results = new Set<(ok: boolean) => void>(), retire = new Set<() => void>();
  let current = { draftId: 'one', version: 1 }, owner = {}, dirty = true, requests = 0;
  const save = createWriterSaveCoordinator({ current: () => current, owner: () => owner, dirty: () => dirty,
    request: () => { requests++; if (failRequest) { failRequest = false; throw new Error('renderer unavailable'); } }, timeoutMs,
    onResult: fn => { results.add(fn); return () => { results.delete(fn); }; },
    onRetire: fn => { retire.add(fn); return () => { retire.delete(fn); }; },
  });
  return { save, results, retire, requests: () => requests, finish(ok: boolean) { if (ok) { current = {...current, version: 2}; dirty = false; } for (const fn of [...results]) fn(ok); },
    navigate() { for (const fn of [...retire]) fn(); owner = {}; current = { draftId: 'two', version: 1 }; } };
}
test('Writer Save and Download share one full save and return its confirmed revision', async () => {
  const f = fixture(); const save = f.save(), download = f.save();
  assert.equal(save, download); assert.equal(f.requests(), 1);
  f.finish(true); assert.equal((await save).version, 2); assert.equal((await download).version, 2);
  assert.equal(f.results.size, 0); assert.equal(f.retire.size, 0);
});
test('Writer old document save cannot authorize download of a newly opened document', async () => {
  const f = fixture(); const save = f.save(); f.navigate();
  await assert.rejects(save, /session changed/); f.finish(true);
  assert.equal(f.results.size, 0);
});
test('Writer timed out save stays single-flight until its actual result arrives', async () => {
  const f = fixture(10); const save = f.save();
  await assert.rejects(save, /taking longer/); assert.equal(f.save(), save);
  assert.equal(f.requests(), 1); f.finish(true);
  assert.equal((await f.save()).version, 2); assert.equal(f.requests(), 1);
});
test('Writer failed saves remain retryable and never report a saved revision', async () => {
  const f = fixture(); const first = f.save(); f.finish(false); await assert.rejects(first, /did not complete/);
  const retry = f.save(); assert.equal(f.requests(), 2); f.finish(true); assert.equal((await retry).version, 2);
});
test('Writer dispatch failure retires listeners and permits a new save', async () => {
  const f = fixture(1000, true); await assert.rejects(f.save(), /renderer unavailable/);
  assert.equal(f.results.size, 0); assert.equal(f.retire.size, 0);
  const retry = f.save(); assert.equal(f.requests(), 2); f.finish(true); assert.equal((await retry).version, 2);
});
