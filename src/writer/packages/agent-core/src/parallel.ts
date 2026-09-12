/** Keep result order while bounding independent reads to avoid provider bursts. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  const output: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await work(items[index]!);
      }
    }),
  );
  return output;
}
