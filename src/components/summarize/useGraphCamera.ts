import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { fitGraphNodes, type GraphView } from "@/lib/pile/knowledge-graph-view";

/** One camera for nodes, groups, paths, and insights. Manual gestures interrupt flights. */
export function useGraphCamera(
  viewport: RefObject<HTMLDivElement | null>,
  items: readonly { id: string; x: number; y: number }[],
  selection: readonly string[] | null,
  enabled: boolean,
) {
  const [camera, setCamera] = useState<GraphView>({ x: 0, y: 0, k: 1 });
  const current = useRef(camera);
  const frame = useRef<number | null>(null);
  const initialized = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const move = useCallback(
    (target: GraphView, animate = false) => {
      stop();
      const start = current.current;
      const commit = (next: GraphView) => {
        current.current = next;
        setCamera(next);
      };
      if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        commit(target);
        return;
      }
      const began = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - began) / 360);
        const eased = 1 - (1 - progress) ** 3;
        commit({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          k: start.k + (target.k - start.k) * eased,
        });
        frame.current = progress < 1 ? requestAnimationFrame(tick) : null;
      };
      frame.current = requestAnimationFrame(tick);
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    const node = viewport.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [enabled, stop, viewport]);

  const fit = useCallback(() => {
    if (!enabled) return;
    const selected = selection ? new Set(selection) : null;
    const targets = selected ? items.filter((item) => selected.has(item.id)) : items;
    const target = fitGraphNodes(size, targets);
    if (!target) return;
    move(target, initialized.current);
    initialized.current = true;
  }, [enabled, items, move, selection, size]);
  useEffect(() => {
    fit();
  }, [fit]);

  const pan = useCallback(
    (dx: number, dy: number) => {
      move({ ...current.current, x: current.current.x + dx, y: current.current.y + dy });
    },
    [move],
  );
  const zoom = useCallback(
    (factor: number) => {
      const old = current.current;
      const k = Math.min(4, Math.max(Math.min(0.03, old.k), old.k * factor));
      const ratio = k / old.k;
      move({
        k,
        x: size.width / 2 - (size.width / 2 - old.x) * ratio,
        y: size.height / 2 - (size.height / 2 - old.y) * ratio,
      });
    },
    [move, size],
  );
  return { camera, current, move, pan, zoom, fit, stop };
}
