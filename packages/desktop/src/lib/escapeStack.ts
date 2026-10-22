import { useEffect, useRef } from "react";

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
 * later is still open. */
export function useEscape(handler: () => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const layer: Layer = { handle: () => ref.current() };
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [enabled]);
}
