import {ulid} from 'ulid';
import type {OfficeDocSummary,OfficeKind} from '@/lib/office/types';
const pending=new Map<string,{docId:string;operationId:string}>();

/** Browser upload/Save As. A retry reuses its original creation identity. */
export async function createLargeOfficeDocument(kind:OfficeKind,name:string,bytes:ArrayBuffer|Uint8Array):Promise<OfficeDocSummary> {
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),x=>x.toString(16).padStart(2,'0')).join('');
  const key=JSON.stringify([kind,name,hash]);
  if (!pending.has(key)) {if(pending.size>=30)pending.delete(pending.keys().next().value!);pending.set(key,{docId:ulid(),operationId:crypto.randomUUID()});}
  const input={...pending.get(key)!,kind,name,size:bytes.byteLength,sha256:hash};
  const control=async(method:string)=>{
    const response=await fetch('/api/office/uploads',{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    let body: any;
    try {body=await response.json();} catch {throw new Error('The upload confirmation was incomplete. Retry this same upload.');}
    if(!response.ok)throw new Error(body?.error||'The document upload failed.');return body;
  };
  const grant=await control('POST');
  if (!grant || typeof grant.url !== 'string' || !/^https?:\/\//.test(grant.url) || typeof grant.checksum !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(grant.checksum))
    throw new Error('The upload authorization was incomplete. Retry this same upload.');
  const result=await fetch(grant.url,{method:'PUT',credentials:'omit',redirect:'error',headers:{'x-amz-checksum-sha256':grant.checksum},body:new Blob([bytes as BlobPart])});
  if(!result.ok)throw new Error('The document upload failed. Retry to preserve this upload identity.');
  const saved=await control('PUT');
  if (!saved || saved.draftId!==input.docId || saved.kind!==kind || typeof saved.name!=='string' ||
    !Number.isSafeInteger(saved.version) || saved.version<1 || !/^[a-f0-9]{64}$/.test(saved.hash??'') ||
    !Number.isSafeInteger(saved.size) || saved.size<1 || saved.size>30*1024*1024 ||
    (saved.version===1 && (saved.hash!==hash || saved.size!==input.size)))
    throw new Error('The saved document confirmation was incomplete. Retry this same upload.');
  pending.delete(key);return saved;
}
