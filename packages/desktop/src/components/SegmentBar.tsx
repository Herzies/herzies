import { cn } from "../lib/utils";

/**
 * A 40-segment progress bar.
 *
 * Segments rather than a percentage-width fill: the app is terminal-native,
 * and a smoothly-growing div reads as generic game UI where a row of discrete
 * blocks reads like the rest of Herzies. Extracted from the XP bar in
 * HomeView so the boss HP and timer bars are the same object, not a lookalike.
 */
export function SegmentBar({
  progress,
  colour = "bg-green",
  className,
}: {
  /** 0..1. Values outside the range are clamped. */
  progress: number;
  /** Tailwind background class for filled segments. */
  colour?: string;
  className?: string;
}) {
  const clamped = Math.max(
    0,
    Math.min(1, Number.isFinite(progress) ? progress : 0),
  );
  const filled = Math.round(clamped * 40);

  return (
    <div className={cn("flex h-2 gap-0.5", className)}>
      {Array.from({ length: 40 }, (_, i) => (
        <div
          key={i}
          className={cn("flex-1", i < filled ? colour : "bg-[#333]")}
        />
      ))}
    </div>
  );
}
