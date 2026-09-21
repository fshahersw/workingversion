/** Keep failed runs locked until pending applies and rollback have both settled. */
export async function finalizeFailedRun<T>(steps: {
  settle: () => Promise<T>;
  restore: () => Promise<boolean>;
  save: (settled: T) => Promise<void>;
  onError: (error: unknown) => void;
  finish: () => void;
}): Promise<void> {
  try {
    const settled = await steps.settle();
    // Incomplete/unsupported rollback must never be persisted automatically.
    if (await steps.restore()) await steps.save(settled);
  } catch (error) {
    steps.onError(error);
  } finally {
    steps.finish();
  }
}
