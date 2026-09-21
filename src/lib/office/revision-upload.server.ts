import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { bucketName, deleteObject, s3 } from '@/lib/data/s3.server';
import { docPrefix, getOfficeDoc, getSavedOfficeOperation, OfficeError, saveOfficeRevision, sha256 } from './office.server';
import { IDEMPOTENCY_KEY, MAX_OFFICE_BYTES, SHA256_HEX } from './types';

export type RevisionUpload = { docId: string; expectedVersion: number; operationId: string; size: number; sha256: string };
export function validateRevisionUpload(input: RevisionUpload): void {
  if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !IDEMPOTENCY_KEY.test(input.operationId ?? '') || !SHA256_HEX.test(input.sha256 ?? '') ||
      !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_OFFICE_BYTES)
    throw new OfficeError(422, 'Invalid revision upload. Maximum file size is 30 MB.');
}
export function revisionUploadKey(principal: string, input: RevisionUpload): string {
  validateRevisionUpload(input);
  return docPrefix(principal, input.docId).replace(/^drafts\//, 'office-uploads/') + `${input.expectedVersion}-${input.operationId}-${input.sha256}`;
}

/** Only the short control messages cross Lambda; native file bytes go to S3. */
export async function prepareRevisionUpload(principal: string, input: RevisionUpload) {
  const key = revisionUploadKey(principal, input);
  const document = await getOfficeDoc(principal, input.docId); // ownership before signing
  if (document.version !== input.expectedVersion) {
    // Allow a lost commit response to retry the same bytes; saveOfficeRevision
    // still requires the original operation ID for an idempotent replay.
    const completed = document.revisions.find(r => r.version === input.expectedVersion + 1 && r.hash === input.sha256);
    if (!completed) throw new OfficeError(409, 'The document changed. Reopen or save a separate copy.');
  }
  const checksum = Buffer.from(input.sha256, 'hex').toString('base64');
  const url = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucketName(), Key: key,
    ContentLength: input.size, ChecksumSHA256: checksum }), {
    expiresIn: 900, signableHeaders: new Set(['content-length', 'x-amz-checksum-sha256']),
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, checksum, expiresIn: 900 };
}

export async function commitRevisionUpload(principal: string, input: RevisionUpload) {
  const key = revisionUploadKey(principal, input);
  const replay = await getSavedOfficeOperation(principal, input); // ownership checked again at commit
  if (replay) {
    if (replay.size !== input.size) throw new OfficeError(422, 'The uploaded file size does not match the saved revision.');
    await deleteObject(key).catch(() => undefined);
    return replay;
  }
  const object = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  if (object.ContentLength !== input.size || !object.Body) {
    (object.Body as { destroy?(): void } | undefined)?.destroy?.();
    throw new OfficeError(422, 'The uploaded file size does not match. Retry the save.');
  }
  const bytes = await object.Body.transformToByteArray();
  if (bytes.length !== input.size || sha256(bytes) !== input.sha256)
    throw new OfficeError(422, 'The uploaded file checksum does not match. Retry the save.');
  // Full native validation, conditional revision update and operation replay
  // remain in the same authoritative save path as small binary requests.
  const result = await saveOfficeRevision(principal, { ...input, bytes });
  // Cleanup is best effort after a confirmed commit. Unfinished uploads expire
  // under the office-uploads/ lifecycle rule; they are never document revisions.
  await deleteObject(key).catch(() => undefined);
  return result;
}

export async function readRevisionUpload(request: Request, docId: string): Promise<RevisionUpload> {
  if (!request.body) throw new OfficeError(422, 'Missing revision control request.');
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) throw new OfficeError(413, 'Revision control request is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let input: RevisionUpload;
  try { input = { ...JSON.parse(text), docId }; } catch { throw new OfficeError(422, 'Invalid revision control request.'); }
  validateRevisionUpload(input);
  return input;
}
