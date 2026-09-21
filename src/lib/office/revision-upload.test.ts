import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revisionUploadKey, validateRevisionUpload, readRevisionUpload } from './revision-upload.server';
const sample = {docId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',expectedVersion:1,operationId:'synthetic-operation',size:5_000_000,sha256:'a'.repeat(64)};
test('revision staging binds owner, document, revision, operation and exact content hash', () => {
  const first = revisionUploadKey('owner-one', sample);
  assert.notEqual(first, revisionUploadKey('owner-two', sample));
  for (const change of [{expectedVersion:2},{operationId:'another-operation'},{sha256:'b'.repeat(64)},{docId:'01ARZ3NDEKTSV4RRFFQ69G5FAW'}])
    assert.notEqual(first, revisionUploadKey('owner-one', {...sample,...change}));
  assert.match(first, /^office-uploads\/owner-one\//);
  assert.throws(() => revisionUploadKey('../owner', sample));
  assert.throws(() => revisionUploadKey('owner-one', {...sample,docId:'../other'}));
});
test('staging rejects invalid or excessive files before granting storage access', () => {
  for (const invalid of [{size:0},{size:31*1024*1024},{size:1.5},{expectedVersion:0},{operationId:'../path'},{sha256:'fake'}])
    assert.throws(() => validateRevisionUpload({...sample,...invalid}));
});
test('revision control parser owns document id and stops oversized streaming input', async () => {
  const parsed = await readRevisionUpload(new Request('http://localhost', {method:'POST',body:JSON.stringify({...sample,docId:'spoof'})}), sample.docId);
  assert.equal(parsed.docId,sample.docId);
  await assert.rejects(readRevisionUpload(new Request('http://localhost',{method:'POST',body:'x'.repeat(3000)}),sample.docId), /too large/);
  await assert.rejects(readRevisionUpload(new Request('http://localhost',{method:'POST',body:'{'}),sample.docId), /Invalid revision/);
});
