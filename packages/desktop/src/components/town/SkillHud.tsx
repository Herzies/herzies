import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { bossFight } from "./combat/fight";
import { buffOn } from "./combat/skills";

/**
 * A Cymbrella you're under, counting down: how much less damage, and the
 * seconds left. Your class skill itself sits on the hotbar (Hotbar.tsx),
 * with its cooldown. (A level-up is a notice: lib/notices.ts.)
 */
export function SkillHud({
  className = "bottom-3 right-2",
}: {
  /** Where it sits: absolute-positioning classes. */
  className?: string;
}) {
  const buffBox = useRef<HTMLDivElement>(null);

  // Runs off the frame clock, not renders.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      if (buffBox.current) {
        const b = buffOn(bossFight.you, "cymbrella", now);
        buffBox.current.style.display = b ? "" : "none";
        if (b)
          buffBox.current.textContent = `🛡 ${Math.round(b.value * 100)}% · ${Math.ceil((b.until - now) / 1000)}s`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-30 flex flex-col items-center gap-1",
        className,
      )}
    >
      <div
        ref={buffBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-yellow"
        style={{ display: "none" }}
      />
    </div>
  );
}
