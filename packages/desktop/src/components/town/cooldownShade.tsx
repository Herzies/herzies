import { useEffect, useRef } from "react";

/** One animation loop for every cooldown shown: runs while any is mounted. */
const cooldownWatchers = new Set<(now: number) => void>();
let cooldownRaf = 0;
function cooldownFrame() {
  const now = performance.now();
  for (const w of cooldownWatchers) w(now);
  cooldownRaf = cooldownWatchers.size
    ? requestAnimationFrame(cooldownFrame)
    : 0;
}
function onCooldownFrame(w: (now: number) => void): () => void {
  cooldownWatchers.add(w);
  if (!cooldownRaf) cooldownRaf = requestAnimationFrame(cooldownFrame);
  return () => {
    cooldownWatchers.delete(w);
  };
}

/** A cooldown over a box (a hotbar slot, a loadout tab): greyed from the
 * top, and the seconds left bottom right unless `seconds` is false.
 * `left(now)` is the milliseconds left of `span`, read each frame (the
 * latest one passed). Put it in a `relative overflow-hidden` box. */
export function useCooldownShade(
  left: (now: number) => { ms: number; span: number },
  { seconds = true }: { seconds?: boolean } = {},
) {
  const shade = useRef<HTMLSpanElement>(null);
  const secs = useRef<HTMLSpanElement>(null);
  const leftRef = useRef(left);
  leftRef.current = left;
  // Off the frame clock, not renders: writing only what changed.
  useEffect(() => {
    let height = "";
    return onCooldownFrame((now) => {
      if (!shade.current) return;
      const { ms, span } = leftRef.current(now);
      const f = Math.min(1, ms / Math.max(1, span));
      const h = `${Math.round(f * 1000) / 10}%`;
      if (h !== height) {
        height = h;
        shade.current.style.height = h;
      }
      if (!secs.current) return;
      // Text only when it changes (a write replaces the node).
      const text = f > 0 ? String(Math.ceil(ms / 1000)) : "";
      if (secs.current.textContent !== text) secs.current.textContent = text;
    });
  }, []);
  return (
    <>
      <span
        ref={shade}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 bg-black/60"
        style={{ height: 0 }}
      />
      {seconds ? (
        <span
          ref={secs}
          className="absolute right-0.5 bottom-0 text-[9px] leading-none text-white tabular-nums"
        />
      ) : null}
    </>
  );
}
