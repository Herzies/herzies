import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { NOTICE_FADE_MS, type Notice, useNotices } from "../lib/notices";

/** A hard dark outline, so the text reads over anything (the 3D Town, a
 * bright card) without a box behind it. */
const OUTLINE =
  "0 1px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000, 0 2px 4px rgba(0,0,0,0.6)";

/** Each line's height in the stack, px. */
const LINE = 18;

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * The notices (see lib/notices.ts): centred, a little under a quarter of the way down, the
 * newest at the bottom with the older ones pushed up above it. Each pops
 * in, holds, then floats up and fades. Mounted once at the root; nothing in
 * it takes the mouse.
 */
export function Notices() {
  const notices = useNotices();
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[400] flex justify-center"
      style={{ top: "22%" }}
    >
      <div className="relative w-full">
        {notices.map((n, i) => (
          <Line key={n.id} notice={n} up={notices.length - 1 - i} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function Line({ notice, up }: { notice: Notice; up: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // (Re)start on arrival and whenever the same text comes again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bump restarts it
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.animate) return;
    const still = reducedMotion();
    const total = notice.holdMs + NOTICE_FADE_MS;
    const held = notice.holdMs / total;
    const anim = el.animate(
      still
        ? [
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: Math.min(0.1, held) },
            { opacity: 1, offset: held },
            { opacity: 0, offset: 1 },
          ]
        : [
            { opacity: 0, transform: "translateY(6px) scale(1.12)", offset: 0 },
            {
              opacity: 1,
              transform: "translateY(0) scale(1)",
              offset: Math.min(120 / total, held),
            },
            { opacity: 1, transform: "translateY(0) scale(1)", offset: held },
            {
              opacity: 0,
              transform: "translateY(-26px) scale(1)",
              offset: 1,
            },
          ],
      { duration: total, easing: "linear", fill: "forwards" },
    );
    return () => anim.cancel();
  }, [notice.bump, notice.holdMs]);

  return (
    <div
      className="absolute inset-x-0 flex justify-center transition-transform duration-200 ease-out motion-reduce:transition-none"
      style={{ transform: `translateY(${-up * LINE}px)` }}
    >
      <div
        ref={ref}
        className="max-w-[80vw] px-2 text-center text-[12px] font-bold leading-[18px] tracking-wide text-white"
        style={{ textShadow: OUTLINE }}
      >
        {notice.text}
      </div>
    </div>
  );
}
