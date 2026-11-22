import { useEffect, useRef } from "react";

/**
 * Loads now, and again every `everyMs` while the window is focused, for as
 * long as `enabled`.
 *
 * A new `key` (whatever the load depends on: a board, a code list, a reload
 * trigger) loads at once. Focus alone loads only when it comes back with the
 * last load more than half an interval old, and losing it never loads: the
 * tray window blurs and refocuses all the time, and every view used to
 * refetch everything on each of those, blur included.
 *
 * `load` gets an `alive()` check for dropping answers that arrive after a new
 * key or unmount. A blur doesn't count: what was asked for still lands.
 */
export function usePoll(
  load: (alive: () => boolean) => void,
  {
    enabled,
    focused,
    everyMs,
    key = "",
  }: { enabled: boolean; focused: boolean; everyMs: number; key?: string },
): void {
  const loadRef = useRef(load);
  loadRef.current = load;
  /** Bumped on each new key and on unmount; answers check it. */
  const generation = useRef(0);
  const lastLoadAt = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger
  useEffect(() => {
    if (!enabled) return;
    const mine = ++generation.current;
    lastLoadAt.current = Date.now();
    loadRef.current(() => generation.current === mine);
    return () => {
      generation.current += 1;
    };
  }, [enabled, key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key restarts the interval after the load above
  useEffect(() => {
    if (!enabled || !focused) return;
    const run = () => {
      const mine = generation.current;
      lastLoadAt.current = Date.now();
      loadRef.current(() => generation.current === mine);
    };
    if (Date.now() - lastLoadAt.current >= everyMs / 2) run();
    const interval = setInterval(run, everyMs);
    return () => clearInterval(interval);
  }, [enabled, focused, everyMs, key]);
}
