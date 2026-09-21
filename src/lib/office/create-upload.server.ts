import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { bucketName, deleteObject, s3 } from '@/lib/data/s3.server';
import { createOfficeDoc, docPrefix, OfficeError, sha256 } from './office.server';
import { validateRevisionUpload } from './revision-upload.server';
import { cleanOfficeName, isOfficeKind, type OfficeKind } from './types';

export type CreateUpload = {docId:string; operationId:string; kind:OfficeKind; name:string; size:number; sha256:string};
export function createUploadKey(principal:string,input:CreateUpload) {
  validateRevisionUpload({...input,expectedVersion:1});
  if (!isOfficeKind(input.kind) || typeof input.name !== 'string' || input.name.length>1000 || !input.name.trim())
    throw new OfficeError(422,'A supported document kind and filename are required.');
  const metadata = sha256(Buffer.from(JSON.stringify([input.kind,cleanOfficeName(input.kind,input.name)])));
  return docPrefix(principal,input.docId).replace(/^drafts\//,'office-uploads/')+`create-${input.operationId}-${input.sha256}-${metadata}`;
}
export async function prepareCreateUpload(principal:string,input:CreateUpload) {
  const key=createUploadKey(principal,input),checksum=Buffer.from(input.sha256,'hex').toString('base64');
  const url=await getSignedUrl(s3(),new PutObjectCommand({Bucket:bucketName(),Key:key,ContentLength:input.size,ChecksumSHA256:checksum}),
    {expiresIn:900,signableHeaders:new Set(['content-length','x-amz-checksum-sha256']),unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
  return {url,checksum,expiresIn:900};
}
export async function commitCreateUpload(principal:string,input:CreateUpload) {
  const key=createUploadKey(principal,input);
  const object=await s3().send(new GetObjectCommand({Bucket:bucketName(),Key:key}));
  if (object.ContentLength !== input.size || !object.Body) {
    (object.Body as {destroy?():void}|undefined)?.destroy?.(); throw new OfficeError(422,'The uploaded file size does not match. Retry the upload.');
  }
  const bytes=await object.Body.transformToByteArray();
  if (bytes.length!==input.size || sha256(bytes)!==input.sha256) throw new OfficeError(422,'The uploaded file checksum does not match. Retry the upload.');
  const result=await createOfficeDoc(principal,{kind:input.kind,name:input.name,bytes},{docId:input.docId,operationId:input.operationId});
  await deleteObject(key).catch(()=>undefined);
  return result;
}
export async function readCreateUpload(request:Request):Promise<CreateUpload> {
  if (!request.body) throw new OfficeError(422,'Missing upload control request.');
  const reader=request.body.getReader(),decoder=new TextDecoder();let text='',size=0;
  try {for (;;) {const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
    if(size>2048)throw new OfficeError(413,'Upload control request is too large.');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();
  } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  try {return JSON.parse(text);} catch {throw new OfficeError(422,'Invalid upload control request.');}
}
