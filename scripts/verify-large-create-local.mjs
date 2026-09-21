import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {ulid} from 'ulid';
assert.equal(process.env.LOCAL_SYNTHETIC_MODE,'1');assert.notEqual(process.env.NODE_ENV,'production');
const origin='http://127.0.0.1:5189',path=origin+'/api/office/uploads';
const bytes=await readFile('.integration.local/results/writer-complex/tables-and-images.docx');
const input={docId:ulid(),operationId:randomUUID(),kind:'docx',name:'Synthetic large Save As.docx',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
async function control(method,input,expected=200){const response=await fetch(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(input)});const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body;}
async function stage(value){const grant=await control('POST',value);assert.equal(new URL(grant.url).origin,'http://127.0.0.1:4568');const put=await fetch(grant.url,{method:'PUT',headers:{'x-amz-checksum-sha256':grant.checksum},body:bytes});assert.equal(put.status,200);}
await stage(input);const saved=await control('PUT',input);assert.equal(saved.draftId,input.docId);assert.equal(saved.version,1);
await stage(input);const replay=await control('PUT',input);assert.equal(replay.draftId,input.docId);assert.equal(replay.version,1);
const changed={...input,name:'Must not replace.docx'};await stage(changed);await control('PUT',changed,409);
const denied=await fetch(path,{method:'POST',headers:{authorization:'Bearer synthetic-invalid','content-type':'application/json'},body:JSON.stringify(input)});assert.equal(denied.status,403);
const read=await fetch(`${origin}/api/writer/docs/${input.docId}/content?download=1`);assert.equal(read.status,200);
assert.equal(createHash('sha256').update(new Uint8Array(await read.arrayBuffer())).digest('hex'),input.sha256);
const report={synthetic:true,awsValidated:false,docId:input.docId,version:1,size:bytes.length,hash:input.sha256,idempotentCreate:true,changedMetadataRejected:true,engineTokenRejected:true,downloadExact:true};
await writeFile('.integration.local/results/writer-complex/create-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
