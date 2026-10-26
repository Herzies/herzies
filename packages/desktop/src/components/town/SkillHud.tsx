import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { bossFight } from "./combat/fight";
import { buffOn, skills } from "./combat/skills";

/**
 * What your buffs are doing right now, beside the hotbar: a Cymbrella
 * you're under (how much less damage, the seconds left) and Rattled from
 * the boss's busters (stacks, seconds left: time to hand the boss over).
 * Your skills sit on the hotbar (Hotbar.tsx) with their cooldowns; a skill
 * being played, or a Bard playing you back up, is the cast bar over its
 * middle (CastBar). (A level-up is a notice: lib/notices.ts.)
 */
export function SkillHud({
  className = "bottom-3 right-2",
}: {
  /** Where it sits: absolute-positioning classes. */
  className?: string;
}) {
  const buffBox = useRef<HTMLDivElement>(null);
  const rattledBox = useRef<HTMLDivElement>(null);

  // Runs off the frame clock, not renders.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      if (buffBox.current) {
        const b = buffOn(bossFight.you, "cymbrella", now);
        buffBox.current.style.display = b ? "" : "none";
        const text = b
          ? `🛡 ${Math.round(b.value * 100)}% · ${Math.ceil((b.until - now) / 1000)}s`
          : "";
        if (b && buffBox.current.textContent !== text)
          buffBox.current.textContent = text;
      }
      if (rattledBox.current) {
        const r = buffOn(bossFight.you, "rattled", now);
        rattledBox.current.style.display = r ? "" : "none";
        const text = r
          ? `Rattled ×${r.value} · ${Math.ceil((r.until - now) / 1000)}s${r.value >= 2 ? " — hand the boss over" : ""}`
          : "";
        if (r && rattledBox.current.textContent !== text)
          rattledBox.current.textContent = text;
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
        ref={rattledBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-[#ff8a7a]"
        style={{ display: "none" }}
      />
      <div
        ref={buffBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-yellow"
        style={{ display: "none" }}
      />
    </div>
  );
}

/** How far a channel has got, 0 to 1. */
const progress = (c: { from: number; until: number }, now: number) =>
  Math.min(1, (now - c.from) / Math.max(1, c.until - c.from));

/**
 * The cast bar: a skill with a cast time being played (Resurrect: hold
 * still), or a Bard playing you back up while you're down. Centred over the
 * hotbar, in the gap between it and your herzie, where the eye already is.
 * Shows nothing (and takes no room) the rest of the time.
 */
export function CastBar({ className }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let shown = "";
    const step = () => {
      const now = performance.now();
      const you = bossFight.you;
      // Yours first; else a Bard playing you back up.
      const mine = you !== null ? skills.channels.get(you) : undefined;
      let saving: { from: number; until: number } | undefined;
      if (you !== null && !(mine && now < mine.until))
        for (const c of skills.channels.values())
          if (c.target === you && now < c.until) saving = c;
      const ch = mine && now < mine.until ? mine : saving;
      const kind = ch === mine && ch ? "mine" : ch ? "saving" : "";
      if (box.current && label.current && fill.current) {
        box.current.style.display = ch ? "" : "none";
        if (kind !== shown) {
          shown = kind;
          label.current.textContent =
            kind === "mine"
              ? "Resurrect · hold still"
              : kind === "saving"
                ? "A Bard is bringing you back…"
                : "";
          box.current.dataset.kind = kind;
        }
        if (ch) fill.current.style.width = `${progress(ch, now) * 100}%`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={box}
      role="status"
      className={cn(
        "group pointer-events-none absolute z-30 w-48 rounded-md border border-white/15 bg-black/65 px-2 py-1 text-center text-[11px] backdrop-blur-sm",
        className,
      )}
      style={{ display: "none" }}
    >
      <div
        ref={label}
        className="leading-4 text-[#ffd84a] group-data-[kind=saving]:text-[#7ee2a8]"
      />
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-sm bg-white/15">
        <div
          ref={fill}
          className="h-full bg-[#ffd84a] group-data-[kind=saving]:bg-[#7ee2a8]"
        />
      </div>
    </div>
  );
}
