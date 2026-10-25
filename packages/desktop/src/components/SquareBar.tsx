import { totalXpForLevel, xpForLevel } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Tooltip } from "./Tooltip";

/** Each square's side and the gap between two (px). Whole pixels, so every
 * gap renders the same — spreading squares to fill the width left fractional
 * gaps that rounded unevenly. */
const SQUARE = 5;
const GAP = 1;

/**
 * A small label and a row of square segments filled to `progress`; hovering
 * the bar shows `tip`. As many squares as fit the width. The exp and hp bars
 * on Home and the Town card.
 */
export function SquareBar({
  label,
  progress,
  tip,
  fill,
  ariaLabel,
  ariaMax,
  ariaNow,
  className,
}: {
  /** Before the bar; none for a bare one. */
  label?: string;
  /** 0..1. */
  progress: number;
  tip: string;
  /** The filled squares' background class. */
  fill: string;
  ariaLabel: string;
  ariaMax: number;
  ariaNow: number;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () =>
      setCount(
        Math.max(1, Math.floor((el.clientWidth + GAP) / (SQUARE + GAP))),
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filled = Math.round(Math.max(0, Math.min(1, progress)) * count);
  return (
    <div className={cn("flex items-center gap-1.5 text-ui", className)}>
      {/* A fixed width, wide enough for "exp:" (4 × 0.6em of the mono font),
          so stacked bars start at the same x. */}
      {label ? (
        <span className="w-6 shrink-0 whitespace-nowrap text-ui-sm leading-none [text-shadow:0_1px_2px_#000]">
          {label}
        </span>
      ) : null}
      {/* pointer-events-auto: the Town card around it ignores the mouse. */}
      <Tooltip label={tip} className="pointer-events-auto min-w-0 flex-1">
        <div
          ref={barRef}
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={ariaMax}
          aria-valuenow={ariaNow}
          // contain: inline-size — the squares (as many as fit) don't count
          // toward the bar's own width, or a bar that has grown could never
          // shrink again: they would hold it at its old width, and it only
          // re-counts them when it resizes.
          className="flex h-[5px] w-full gap-px overflow-hidden [contain:inline-size]"
        >
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              className={cn(
                "size-[5px] shrink-0",
                i < filled ? fill : "bg-[#333]",
              )}
            />
          ))}
        </div>
      </Tooltip>
    </div>
  );
}

/** Progress to the next level; the tooltip has it as "xp / needed exp" and
 * a percentage (just the percentage without the herzie's XP). */
export function ExpBar({
  progress,
  level,
  xp,
  className,
}: {
  /** 0..1 through the current level. */
  progress: number;
  /** The herzie's level and total XP, for the numbers in the tooltip. */
  level?: number;
  xp?: number;
  className?: string;
}) {
  const pct = Math.floor(progress * 100);
  const tip =
    level !== undefined && xp !== undefined
      ? `${Math.max(0, Math.floor(xp - totalXpForLevel(level))).toLocaleString()} / ${xpForLevel(level + 1).toLocaleString()} exp (${pct}%)`
      : `${pct}%`;
  return (
    <SquareBar
      label="exp:"
      progress={progress}
      tip={tip}
      fill="bg-green"
      ariaLabel="Experience"
      ariaMax={100}
      ariaNow={pct}
      className={className}
    />
  );
}

/** Health; the tooltip has it as "hp / max". */
export function HpBar({
  hp,
  maxHp,
  className,
}: {
  hp: number;
  maxHp: number;
  className?: string;
}) {
  return (
    <SquareBar
      label="hp:"
      progress={maxHp > 0 ? hp / maxHp : 0}
      tip={`${Math.ceil(hp)} / ${maxHp}`}
      fill="bg-red"
      ariaLabel="Health"
      ariaMax={maxHp}
      ariaNow={Math.round(hp)}
      className={className}
    />
  );
}
