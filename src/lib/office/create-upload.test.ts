import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createUploadKey,readCreateUpload} from './create-upload.server';
const input={docId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',operationId:'synthetic-creation',kind:'docx' as const,name:'Synthetic.docx',size:8_000_000,sha256:'a'.repeat(64)};
test('creation staging binds owner, fresh document identity, bytes and kind/name metadata',()=>{
  const key=createUploadKey('owner-one',input);
  assert.match(key,/^office-uploads\/owner-one\//);
  assert.notEqual(key,createUploadKey('owner-two',input));
  for(const change of [{name:'Other.docx'},{kind:'pdf' as const},{operationId:'other-create'},{sha256:'b'.repeat(64)}])
    assert.notEqual(key,createUploadKey('owner-one',{...input,...change}));
  assert.throws(()=>createUploadKey('../owner',input));
  assert.throws(()=>createUploadKey('owner-one',{...input,docId:'../bad'}));
  assert.throws(()=>createUploadKey('owner-one',{...input,size:31*1024*1024}));
  assert.throws(()=>createUploadKey('owner-one',{...input,name:''}));
});
test('create control request refuses excessive bodies and malformed JSON',async()=>{
  const request=(body:string)=>new Request('http://localhost',{method:'POST',body});
  assert.deepEqual(await readCreateUpload(request(JSON.stringify(input))),input);
  await assert.rejects(readCreateUpload(request('x'.repeat(3000))),/too large/);
  await assert.rejects(readCreateUpload(request('{')),/Invalid upload/);
});
