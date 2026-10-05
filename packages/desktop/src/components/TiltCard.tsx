import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { cn } from "../lib/utils";

/** How far (deg) the card leans at the very edge of its face. */
const MAX_TILT = 10;

/** A card that leans toward the cursor in 3D, like a trading card turned in
 * the hand. The pointer position goes into CSS variables on the card
 * (`--rx`/`--ry` tilt, `--mx`/`--my` pointer %, `--hover` 0/1) once per
 * animation frame — never React state, so the card face (a pixel icon is
 * hundreds of rects) isn't re-rendered on every mousemove.
 * The `.holo-*` layers in globals.css read the same variables for the foil
 * and glare.
 *
 * The listeners sit on an untransformed wrapper so the pointer is measured
 * against the card's resting rect, not its tilted one. Off under
 * prefers-reduced-motion. */
export function TiltCard({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (!wrap || !card) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let pointer: { x: number; y: number } | null = null;

    const apply = () => {
      frame = 0;
      if (!pointer) return;
      const r = wrap.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (pointer.x - r.left) / r.width));
      const py = Math.min(1, Math.max(0, (pointer.y - r.top) / r.height));
      card.style.setProperty("--rx", `${(0.5 - py) * 2 * MAX_TILT}deg`);
      card.style.setProperty("--ry", `${(px - 0.5) * 2 * MAX_TILT}deg`);
      card.style.setProperty("--mx", `${px * 100}%`);
      card.style.setProperty("--my", `${py * 100}%`);
    };
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      card.dataset.tilting = "";
      card.style.setProperty("--hover", "1");
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      delete card.dataset.tilting;
      for (const name of ["--rx", "--ry", "--mx", "--my", "--hover"])
        card.style.removeProperty(name);
    };

    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div ref={wrapRef}>
      <div ref={cardRef} className={cn("holo-card", className)} style={style}>
        {children}
      </div>
    </div>
  );
}
