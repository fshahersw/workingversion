// Synthetic, loopback-only persistence acceptance. Never reads credentials or firm data.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Document, Packer, Paragraph, Table, TableRow, TableCell, ImageRun } from 'docx';
import JSZip from 'jszip';

assert.equal(process.env.LOCAL_SYNTHETIC_MODE, '1');
assert.notEqual(process.env.NODE_ENV, 'production');
const origin = 'http://127.0.0.1:5189';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async (path, method, body) => {
  const res = await fetch(origin + path, {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const value = await res.json(); assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(value)}`); return value;
};
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const children = [new Paragraph('Synthetic Writer table and image save verification')];
for(let t=0;t<24;t++) {
  children.push(new Paragraph(`Synthetic table ${t+1}`),new Table({rows:Array.from({length:12},(_,r)=>new TableRow({children:Array.from({length:4},(_,c)=>new TableCell({children:[new Paragraph(`Table ${t+1}, row ${r+1}, column ${c+1}`)]}))}))}));
  children.push(new Paragraph({children:[new ImageRun({type:'png',data:pixel,transformation:{width:20,height:20}})]}));
}
const small = await Packer.toBuffer(new Document({sections:[{children}]}));
const created = await fetch(origin+'/api/writer/docs',{method:'POST',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','X-Writer-Filename':'Synthetic%20Writer%20tables%20and%20images.docx'},body:small});
assert.equal(created.status,201); const doc=await created.json();
const zip=await JSZip.loadAsync(small);
// A valid opaque XML source part makes the native archive exceed Lambda's 6 MB
// request limit without asking the browser to lay out thousands of pages.
zip.file('customXml/item1.xml','<synthetic xmlns="urn:local-verification">'+'x'.repeat(7*1024*1024)+'</synthetic>');
const large=await zip.generateAsync({type:'uint8array',compression:'STORE'});
assert.ok(large.length>6*1024*1024);
const path=`/api/writer/docs/${doc.draftId}/content`;
const upload={expectedVersion:1,operationId:randomUUID(),size:large.length,sha256:digest(large)};
async function stage(input,bytes) {
  const grant=await json(path,'POST',input);
  assert.equal(new URL(grant.url).origin,'http://127.0.0.1:4568','Only the local S3 emulator may receive synthetic bytes');
  const put=await fetch(grant.url,{method:'PUT',headers:{'x-amz-checksum-sha256':grant.checksum},body:bytes});
  assert.ok(put.ok,`Local S3 upload: ${put.status}`);
}
await stage(upload,large);
const saved=await json(path,'PUT',upload); assert.equal(saved.version,2); assert.equal(saved.hash,upload.sha256);
await stage(upload,large);
const replay=await json(path,'PUT',upload); assert.equal(replay.version,2); assert.equal(replay.replayed,true);
const bad={...upload,expectedVersion:2,operationId:randomUUID(),sha256:'a'.repeat(64)};
await stage(bad,large); // Emulator does not enforce SHA; authoritative commit must.
const rejected=await fetch(origin+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(bad)});
assert.equal(rejected.status,422);
const grant=await json(path+'?direct=1','GET');
assert.equal(grant.version,2);assert.equal(grant.hash,upload.sha256);
const bytes=new Uint8Array(await(await fetch(grant.url)).arrayBuffer());assert.equal(digest(bytes),upload.sha256);
const redirect=await fetch(origin+path+'?version=2&download=1',{redirect:'manual'});
assert.equal(redirect.status,302);assert.equal(new URL(redirect.headers.get('location')).origin,'http://127.0.0.1:4568');
const download=await fetch(origin+path+'?version=2&download=1');assert.equal(download.status,200);
assert.match(download.headers.get('content-disposition')??'',/attachment/);
assert.equal(digest(new Uint8Array(await download.arrayBuffer())),upload.sha256);
const reopened=await JSZip.loadAsync(bytes), xml=await reopened.file('word/document.xml').async('string');
assert.equal((xml.match(/<w:tbl>/g)||[]).length,24);assert.equal((xml.match(/<w:drawing>/g)||[]).length,24);
const missing=await fetch(origin+'/api/writer/docs/01ARZ3NDEKTSV4RRFFQ69G5FAV/content?direct=1');assert.equal(missing.status,404);
const report={synthetic:true,awsValidated:false,docId:doc.draftId,version:2,size:bytes.length,hash:upload.sha256,tables:24,images:24,stagedUpload:true,idempotentReplay:true,checksumTamperRejected:true,directLoad:true,downloadRedirect:true,nativePackageVerified:true};
await mkdir('.integration.local/results/writer-complex',{recursive:true});
await writeFile('.integration.local/results/writer-complex/report.json',JSON.stringify(report,null,2));
await writeFile('.integration.local/results/writer-complex/tables-and-images.docx',bytes);
console.log(JSON.stringify(report,null,2));
