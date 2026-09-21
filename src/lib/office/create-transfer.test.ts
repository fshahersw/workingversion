import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLargeOfficeDocument} from '../../office/shared/create-transfer';

test('large create retains its identity after malformed or mismatched successful confirmations',async()=>{
  const original=globalThis.fetch;
  try {
    for(const bad of ['truncated','empty','wrong-document','wrong-hash']) {
      const inputs:Record<string,any>[]=[];let commits=0;
      globalThis.fetch=(async (url:any,init:any)=>{
        if(url==='https://synthetic-storage.test/upload')return new Response(null,{status:200});
        const input=JSON.parse(init.body);inputs.push(input);
        if(init.method==='POST')return Response.json({url:'https://synthetic-storage.test/upload',checksum:Buffer.from(input.sha256,'hex').toString('base64')});
        commits++;
        const saved={draftId:input.docId,kind:input.kind,name:input.name,version:1,hash:input.sha256,size:input.size};
        if(commits===1) {
          if(bad==='truncated')return new Response('{',{status:200,headers:{'content-type':'application/json'}});
          if(bad==='empty')return Response.json({});
          if(bad==='wrong-document')return Response.json({...saved,draftId:'another-document'});
          return Response.json({...saved,hash:'f'.repeat(64)});
        }
        return Response.json(saved);
      }) as typeof fetch;
      await assert.rejects(createLargeOfficeDocument('docx',`Synthetic ${bad}.docx`,new Uint8Array([1,2,3])),/confirmation was incomplete/);
      const saved=await createLargeOfficeDocument('docx',`Synthetic ${bad}.docx`,new Uint8Array([1,2,3]));
      assert.equal(inputs.length,4);assert.equal(saved.draftId,inputs[0]!.docId);
      assert.equal(inputs[0]!.docId,inputs[2]!.docId);assert.equal(inputs[0]!.operationId,inputs[2]!.operationId);
    }
  } finally {globalThis.fetch=original;}
});

test('bad upload grants never dispatch native bytes',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=(async()=>{calls++;return Response.json({url:'https://synthetic-storage.test/upload'});}) as typeof fetch;
  try {await assert.rejects(createLargeOfficeDocument('docx','Invalid grant.docx',new Uint8Array([1])),/authorization was incomplete/);assert.equal(calls,1);}
  finally {globalThis.fetch=original;}
});
