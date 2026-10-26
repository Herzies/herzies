import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { bossFight } from "./combat/fight";
import { buffOn, skills } from "./combat/skills";

/**
 * What your skills are doing right now: a Cymbrella you're under, counting
 * down (how much less damage, the seconds left), and a Resurrect you're
 * playing, as a bar that fills until the fallen are back up (move, and it
 * stops). Your skills themselves sit on the hotbar (Hotbar.tsx), with
 * their cooldowns. (A level-up is a notice: lib/notices.ts.)
 */
export function SkillHud({
  className = "bottom-3 right-2",
}: {
  /** Where it sits: absolute-positioning classes. */
  className?: string;
}) {
  const buffBox = useRef<HTMLDivElement>(null);
  const channelBox = useRef<HTMLDivElement>(null);
  const channelFill = useRef<HTMLDivElement>(null);

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
      if (channelBox.current && channelFill.current) {
        const ch =
          bossFight.you !== null
            ? skills.channels.get(bossFight.you)
            : undefined;
        const on = !!ch && now < ch.until;
        channelBox.current.style.display = on ? "" : "none";
        if (ch && on)
          channelFill.current.style.width = `${Math.min(1, (now - ch.from) / Math.max(1, ch.until - ch.from)) * 100}%`;
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
        ref={channelBox}
        role="status"
        className="w-40 rounded bg-black/60 px-1.5 py-1 text-center text-[11px] text-[#ffd84a]"
        style={{ display: "none" }}
      >
        Resurrecting… hold still
        <div className="mt-0.5 h-1 overflow-hidden rounded-sm bg-white/15">
          <div ref={channelFill} className="h-full bg-[#ffd84a]" />
        </div>
      </div>
      <div
        ref={buffBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-yellow"
        style={{ display: "none" }}
      />
    </div>
  );
}
