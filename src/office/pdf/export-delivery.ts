import type { OfficeDocSummary } from '@/lib/office/types';

/** Per-workspace receipts make a partially completed split safe to retry. */
export function createPdfExportDelivery(
  create: (name: string, bytes: Uint8Array) => Promise<OfficeDocSummary>,
  offer: (docId: string, version: number, name: string) => void,
  isCurrent: () => boolean,
) {
  const receipts = new Map<string, OfficeDocSummary>();
  return async (bytes: Uint8Array, name: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!isCurrent()) throw new Error('This PDF workspace closed.');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), n => n.toString(16).padStart(2, '0')).join('');
    const key = JSON.stringify([name, hash]);
    signal?.throwIfAborted();
    if (!isCurrent()) throw new Error('This PDF workspace closed.');
    let saved = receipts.get(key);
    if (!saved) {
      if (receipts.size >= 30) throw new Error('This workspace has prepared 30 PDF exports. Reopen it before preparing more.');
      saved = await create(name, bytes);
      receipts.set(key, saved);
    }
    // Creation may finish after cancellation. Keep its receipt for retry, but
    // never open a download in a different/closed workspace.
    if (!signal?.aborted && isCurrent()) offer(saved.draftId, saved.version, saved.name);
    return { name: saved.name, docId: saved.draftId, version: saved.version, saved: true };
  };
}
