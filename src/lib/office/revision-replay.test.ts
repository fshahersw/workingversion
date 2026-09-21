import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Compile the real persistence and staged-commit paths. Only storage is fake;
// no AWS clients or application credentials are used by this test.
type Fixture = { row: Record<string, unknown> | null; reads: unknown[][]; gets: number; deleted: string[] };
type ReplayInput = { docId: string; expectedVersion: number; operationId: string; sha256: string; size: number };
const globals = globalThis as unknown as { __officeReplayTest: Fixture };
const modulePromise = (async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = await build({ absWorkingDir: root, stdin: { contents:
    'export { getSavedOfficeOperation } from "./src/lib/office/office.server.ts"; export { commitRevisionUpload } from "./src/lib/office/revision-upload.server.ts";',
    resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    external: ['@/office/pdf/document', '@/lib/writer/legacy-convert.server'],
    plugins: [{ name: 'mock-office-storage', setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/data\/(dynamo|s3)\.server$/ }, args => ({ path: args.path, namespace: 'fake-storage' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake-storage' }, args => ({ contents: args.path.includes('dynamo') ? `
        export const getItem = async (...args) => { globalThis.__officeReplayTest.reads.push(args); return globalThis.__officeReplayTest.row; };
        const fail = () => { throw new Error('Unexpected database mutation'); };
        export const doc = fail, deleteItem = fail, putItem = fail, putItemIfAbsent = fail, queryPrefix = fail, updateItem = fail;
        export const tableName = () => 'synthetic-table';
      ` : `
        export const s3 = () => ({ send: async () => { globalThis.__officeReplayTest.gets++; throw new Error('NoSuchKey: staging already deleted'); } });
        export const bucketName = () => 'synthetic-bucket';
        export const deleteObject = async key => { globalThis.__officeReplayTest.deleted.push(key); };
        export const deletePrefix = async () => { throw new Error('Unexpected prefix deletion'); };
        export const presignGet = async () => { throw new Error('Unexpected presign'); };
      `, loader: 'js' }));
    } }] });
  const filename = path.join(root, '__revision-replay-test.cjs');
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = (Module as unknown as { _nodeModulePaths(path: string): string[] })._nodeModulePaths(root);
  (compiled as unknown as { _compile(code: string, file: string): void })._compile(result.outputFiles[0]!.text, filename);
  return compiled.exports as {
    getSavedOfficeOperation(owner: string, input: ReplayInput): Promise<Record<string, unknown> | null>;
    commitRevisionUpload(owner: string, input: ReplayInput): Promise<Record<string, unknown>>;
  };
})();
const input = { docId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', expectedVersion: 2,
  operationId: 'saved-operation', sha256: 'a'.repeat(64), size: 5_000_000 };
function fixture() {
  const row = { itemId: input.docId, owner: 'synthetic-owner', type: 'draft', kind: 'pptx', name: 'Synthetic.pptx',
    version: 4, hash: 'b'.repeat(64), size: 6_000_000, updatedAt: 'later', createdAt: 'original',
    recovery: { baseVersion: 4, at: 'later-recovery' },
    operations: { [input.operationId]: { hash: input.sha256, version: 3 } },
    revisions: [{ version: 3, hash: input.sha256, size: input.size, createdAt: 'saved-at' },
      { version: 4, hash: 'b'.repeat(64), size: 6_000_000, createdAt: 'later' }] };
  globals.__officeReplayTest = { row, reads: [], gets: 0, deleted: [] };
  return globals.__officeReplayTest;
}

test('saved operation is owner-scoped and returns its exact historical revision metadata', async () => {
  const api = await modulePromise, f = fixture();
  const replay = await api.getSavedOfficeOperation('synthetic-owner', input);
  assert.equal(replay?.version, 3); assert.equal(replay?.hash, input.sha256);
  assert.equal(replay?.size, input.size); assert.equal(replay?.updatedAt, 'saved-at');
  assert.equal(replay?.recovery, null); assert.equal(replay?.replayed, true);
  assert.deepEqual(f.reads[0], ['USER#synthetic-owner', `ITEM#${input.docId}`, { consistent: true }]);
  await assert.rejects(api.getSavedOfficeOperation('another-owner', input), /not found/);
  assert.equal(f.gets, 0); assert.equal(f.deleted.length, 0);
});

test('staged commit replays after upload deletion without reading or rewriting document bytes', async () => {
  const api = await modulePromise, f = fixture();
  const replay = await api.commitRevisionUpload('synthetic-owner', input);
  assert.equal(replay.version, 3); assert.equal(replay.size, input.size);
  assert.equal(f.gets, 0); assert.deepEqual(f.deleted, [
    `office-uploads/synthetic-owner/${input.docId}/2-${input.operationId}-${input.sha256}`]);
});

test('replay cannot bypass operation identity, expected revision, hash, size, or retained revision checks', async () => {
  const api = await modulePromise;
  for (const patch of [{ sha256: 'c'.repeat(64) }, { expectedVersion: 3 }, { size: input.size + 1 }]) {
    const f = fixture();
    await assert.rejects(api.commitRevisionUpload('synthetic-owner', { ...input, ...patch }));
    assert.equal(f.gets, 0); assert.equal(f.deleted.length, 0);
  }
  const f = fixture();
  assert.equal(await api.getSavedOfficeOperation('synthetic-owner', { ...input, operationId: 'new-operation' }), null);
  f.row!.revisions = [];
  await assert.rejects(api.commitRevisionUpload('synthetic-owner', input), /reconciled/);
  assert.equal(f.gets, 0); assert.equal(f.deleted.length, 0);
});
