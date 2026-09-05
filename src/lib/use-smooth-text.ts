import { useEffect, useRef, useState } from "react";

/**
 * Reveals `target` character-by-character at a steady, backlog-aware rate so
 * chunky SSE deltas render as one continuous left-to-right stream instead of
 * arriving in visible bursts.
 */
export function useSmoothText(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming ? "" : target);
  const shownLenRef = useRef(shown.length);
  const targetRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);

  targetRef.current = target;

  // Hard-sync when the message is replaced or streaming ends.
  useEffect(() => {
    if (!streaming) {
      shownLenRef.current = target.length;
      setShown(target);
    }
  }, [streaming, target]);

  useEffect(() => {
    if (target.length < shownLenRef.current) {
      shownLenRef.current = 0;
      setShown("");
    }
  }, [target]);

  useEffect(() => {
    if (!streaming) return;
    const tick = (t: number) => {
      const dt = lastRef.current ? Math.min(64, t - lastRef.current) : 16;
      lastRef.current = t;

      const full = targetRef.current;
      const behind = full.length - shownLenRef.current;
      if (behind > 0) {
        // Base speed ~ 42 chars/sec, accelerating with backlog so we never
        // fall behind a fast model, but never jump in one frame.
        const cps = 40 + behind * 2.6;
        const step = Math.max(1, Math.round((cps * dt) / 1000));
        shownLenRef.current = Math.min(full.length, shownLenRef.current + step);
        setShown(full.slice(0, shownLenRef.current));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastRef.current = 0;
    };
  }, [streaming]);

  return streaming ? shown : target;
}
