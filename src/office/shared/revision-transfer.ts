import type { OfficeDocSummary } from '@/lib/office/types';

async function checked(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, credentials:'same-origin',cache:'no-store' });
  if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || 'The document request failed.');
  return response;
}

/** Preserve one caller-owned operation id across retry; never retry a mutation implicitly. */
export async function transferOfficeRevision(docId: string, version: number, operationId: string, bytes: Uint8Array): Promise<OfficeDocSummary> {
  const path = `/api/office/docs/${encodeURIComponent(docId)}/content`;
  if (bytes.byteLength <= 3*1024*1024) return (await checked(path,{method:'PUT',
    headers:{'Content-Type':'application/octet-stream','If-Match':String(version),'Idempotency-Key':operationId},
    body:new Blob([bytes as BlobPart])})).json();
  const digest=await crypto.subtle.digest('SHA-256',bytes as BufferSource);
  const input={expectedVersion:version,operationId,size:bytes.byteLength,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')};
  const control={headers:{'Content-Type':'application/json'},body:JSON.stringify(input)};
  const grant=await(await checked(path,{...control,method:'POST'})).json() as {url:string;checksum:string};
  const uploaded=await fetch(grant.url,{method:'PUT',credentials:'omit',redirect:'error',
    headers:{'x-amz-checksum-sha256':grant.checksum},body:new Blob([bytes as BlobPart])});
  if (!uploaded.ok) throw new Error('The document upload failed. Your edits remain open; retry Save.');
  return (await checked(path,{...control,method:'PUT'})).json();
}

export async function loadOfficeRevision(docId: string, signal?: AbortSignal) {
  const grant=await(await checked(`/api/office/docs/${encodeURIComponent(docId)}/content?direct=1`,{signal})).json() as {url:string;version:number;hash:string};
  const response=await fetch(grant.url,{credentials:'omit',cache:'no-store',signal});
  if (!response.ok) throw new Error('The saved document could not be loaded. Reopen to refresh its link.');
  return {bytes:new Uint8Array(await response.arrayBuffer()),version:grant.version,hash:grant.hash};
}
