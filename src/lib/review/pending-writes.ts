/** Remove writes only after acknowledgement. A failed/partial request is replayable. */
export function retainedWrites<T, R>(
  pending: T[],
  write: (batch: T[]) => Promise<R[]>,
  onSaved: (saved: R[]) => void,
) {
  let inflight: Promise<void> | null = null;
  return {
    add(item: T) {
      pending.push(item);
    },
    flush(): Promise<void> {
      if (inflight) return inflight;
      const task = async () => {
        while (pending.length) {
          const batch = pending.slice(0, 25);
          const saved = await write(batch);
          // Appends during the request remain queued; a rejection removes nothing.
          pending.splice(0, batch.length);
          onSaved(saved);
        }
      };
      inflight = task().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
