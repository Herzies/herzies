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
  ghost,
  ghostFill = "bg-white/25",
}: {
  /** Before the bar; none for a bare one. */
  label?: string;
  /** 0..1. */
  progress: number;
  /** 0..1, at least `progress`: squares past the fill shown faintly, as
   * what's on its way (the Crystal's XP on the exp bar). */
  ghost?: number;
  /** The faint squares' background class. */
  ghostFill?: string;
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
  const ghosted =
    ghost === undefined
      ? filled
      : Math.max(filled, Math.round(Math.max(0, Math.min(1, ghost)) * count));
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
                i < filled ? fill : i < ghosted ? ghostFill : "bg-[#333]",
              )}
            />
          ))}
        </div>
      </Tooltip>
    </div>
  );
}

/**
 * The bar's fill as shown: glides up to `progress` rather than jumping, and
 * on a level gained runs to full, then on from empty — so a big gain (an
 * attune) is seen filling. Anything else (a drop, the first value, a level
 * lost) just snaps.
 */
function useFillGlide(progress: number, level: number | undefined): number {
  const [shown, setShown] = useState(progress);
  const from = useRef({ progress, level });
  useEffect(() => {
    const prev = from.current;
    from.current = { progress, level };
    const gainedLevels =
      level !== undefined && prev.level !== undefined ? level - prev.level : 0;
    const grew =
      gainedLevels > 0 || (gainedLevels === 0 && progress > prev.progress);
    if (!grew || gainedLevels > 20) {
      setShown(progress);
      return;
    }
    // Distance in "bars": the rest of the old level, whole levels between,
    // then into the new one.
    const total =
      gainedLevels > 0
        ? 1 - prev.progress + (gainedLevels - 1) + progress
        : progress - prev.progress;
    if (total < 0.01) {
      setShown(progress);
      return;
    }
    const duration = Math.min(1600, 400 + total * 700);
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / duration);
      const at = prev.progress + total * (1 - (1 - k) ** 3);
      // Wrap: each whole bar passed is a level.
      setShown(k >= 1 ? progress : at >= 1 ? at % 1 : at);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [progress, level]);
  return shown;
}

/** Progress to the next level; the tooltip has it as "xp / needed exp" and
 * a percentage (just the percentage without the herzie's XP). */
export function ExpBar({
  progress,
  level,
  xp,
  waiting = 0,
  className,
}: {
  /** 0..1 through the current level. */
  progress: number;
  /** XP waiting in the Crystal: drawn faintly past the fill. */
  waiting?: number;
  /** The herzie's level and total XP, for the numbers in the tooltip. */
  level?: number;
  xp?: number;
  className?: string;
}) {
  const pct = Math.floor(progress * 100);
  const base =
    level !== undefined && xp !== undefined
      ? `${Math.max(0, Math.floor(xp - totalXpForLevel(level))).toLocaleString()} / ${xpForLevel(level + 1).toLocaleString()} exp (${pct}%)`
      : `${pct}%`;
  // Where attuning now would take it: the faint squares, and the tooltip.
  let ghost: number | undefined;
  let tip = base;
  if (waiting > 0 && level !== undefined && xp !== undefined) {
    let reach = level;
    while (xp + waiting >= totalXpForLevel(reach + 1)) reach++;
    ghost =
      reach > level
        ? 1
        : (xp + waiting - totalXpForLevel(level)) / xpForLevel(level + 1);
    tip = `${base} · +${Math.floor(waiting).toLocaleString()} exp in your resonance${
      reach > level ? `: enough for level ${reach}` : ""
    }`;
  }
  const shown = useFillGlide(progress, level);
  return (
    <SquareBar
      label="exp:"
      progress={shown}
      ghost={ghost}
      ghostFill="bg-green/35"
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

/** Your resonance: listened time stored up since you last handed it to the
 * Crystal, against what it holds. Past full it stays full and glows
 * ("overcharged"). */
export function CrystalBar({
  fill,
  capacity,
  xp,
  drops,
  className,
}: {
  /** Listened minutes since the last attune. */
  fill: number;
  capacity: number;
  /** XP and finds waiting, for the tooltip. */
  xp: number;
  drops: number;
  className?: string;
}) {
  const progress = capacity > 0 ? fill / capacity : 0;
  const over = progress >= 1;
  const waiting = [
    xp > 0 ? `${Math.floor(xp).toLocaleString()} exp` : null,
    drops > 0 ? `${drops} find${drops === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const tip = over
    ? `Your resonance is ${progress >= 1.25 ? "overcharged" : "full"}. Hand it to the Crystal in Town for ${waiting.join(" and ") || "what it holds"}.`
    : `Resonance: ${Math.floor(fill / 60)}h ${Math.floor(fill % 60)}m of ${Math.round(capacity / 60)}h${
        waiting.length > 0 ? ` · ${waiting.join(" and ")} waiting` : ""
      }`;
  return (
    <SquareBar
      label="◆"
      progress={progress}
      tip={tip}
      fill={over ? "bg-cyan animate-pulse" : "bg-cyan"}
      ariaLabel="Resonance"
      ariaMax={capacity}
      ariaNow={Math.round(Math.min(fill, capacity))}
      className={className}
    />
  );
}
