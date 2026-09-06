export const SSE_HEARTBEAT_MS = 25_000;

/**
 * Keep long model/retrieval gaps alive through CloudFront and API Gateway.
 * SSE comments are ignored by EventSource semantics and by the app parser.
 */
export function startSseHeartbeat(
  enqueue: (comment: string) => void,
  signal?: AbortSignal,
  intervalMs = SSE_HEARTBEAT_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    signal?.removeEventListener("abort", stop);
  };
  const beat = () => {
    if (stopped) return;
    try {
      enqueue(": keep-alive\n\n");
    } catch {
      stop();
    }
  };

  signal?.addEventListener("abort", stop, { once: true });
  beat();
  if (!stopped) timer = setInterval(beat, intervalMs);
  return stop;
}
