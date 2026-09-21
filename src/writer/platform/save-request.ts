/** Bridge the renderer's full save/rebase with browser controls without short
 * false timeouts, parallel requests, or another document's completion event. */
export function createWriterSaveCoordinator<T extends { draftId: string }>(deps: {
  current(): T | null; owner(): unknown; dirty(): boolean; request(): void;
  onResult(fn: (ok: boolean) => void): () => void;
  onRetire(fn: () => void): () => void;
  timeoutMs?: number;
}): () => Promise<T> {
  let pending: { owner: unknown; promise: Promise<T> } | undefined;
  return () => {
    const document = deps.current(), owner = deps.owner();
    if (!document) return Promise.reject(new Error('No document is open.'));
    if (pending && pending.owner === owner) return pending.promise;
    if (!deps.dirty()) return Promise.resolve(document);
    let rejectPass!: (error: Error) => void, cleanupPass = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      rejectPass = reject;
      let timer: ReturnType<typeof setTimeout>, offResult = () => {}, offRetire = () => {};
      const cleanup = () => { clearTimeout(timer); offResult(); offRetire(); if (pending?.owner === owner) pending = undefined; };
      cleanupPass = cleanup;
      offRetire = deps.onRetire(() => { cleanup(); reject(new Error('The document session changed before saving completed.')); });
      offResult = deps.onResult(ok => {
        const current = deps.current(); cleanup();
        if (deps.owner() !== owner || current?.draftId !== document.draftId) reject(new Error('The document session changed before saving completed.'));
        else if (!ok) reject(new Error('Save did not complete. The editor contains the detailed error; your edits remain open.'));
        else resolve(current);
      });
      timer = setTimeout(() => {
        // Retain the in-flight owner until the renderer actually settles. A
        // late result must never complete a newer request with unrelated work.
        reject(new Error('Saving is taking longer than expected. Keep this document open while the current save finishes.'));
      }, deps.timeoutMs ?? 120_000);
    });
    pending = { owner, promise };
    try { deps.request(); } catch (error) { cleanupPass(); rejectPass(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  };
}
