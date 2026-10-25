import { useCallback, useEffect, useRef } from "react";

/**
 * Escape goes to the most recently opened layer only. An item inspect opened
 * inside an overlay window closes on its own, without taking the window with
 * it; the next Escape then closes the window.
 */
type Layer = { handle: () => void };
const layers: Layer[] = [];

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.handle();
});

/** Calls `handler` on Escape while `enabled`, unless a layer registered
 * later is still open. Returns whether this layer is the top one right now
 * (nothing opened over it), for other ways of closing it, like a click
 * outside. */
export function useEscape(handler: () => void, enabled = true): () => boolean {
  const ref = useRef(handler);
  ref.current = handler;
  const mine = useRef<Layer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const layer: Layer = { handle: () => ref.current() };
    mine.current = layer;
    layers.push(layer);
    return () => {
      mine.current = null;
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [enabled]);
  return useCallback(
    () => !!mine.current && layers[layers.length - 1] === mine.current,
    [],
  );
}
