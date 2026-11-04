import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { domeOver } from "./combat/domes";
import { bossFight } from "./combat/fight";
import { buffOn, skills } from "./combat/skills";
import { pendingSlam } from "./combat/slams";
import { townSave } from "./runtime";

/**
 * What your buffs are doing right now, beside the hotbar: a Cymbrella's
 * dome you stand in (nothing gets through; the seconds left) and Rattled from
 * the boss's busters (stacks, seconds left: time to hand the boss over),
 * a Haste (how much faster, the seconds left), and a Shuffle (how many
 * bounces, the seconds left).
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
  const hasteBox = useRef<HTMLDivElement>(null);
  const shuffleBox = useRef<HTMLDivElement>(null);

  // Runs off the frame clock, not renders.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      if (buffBox.current) {
        // Standing in a Cymbrella's dome (anyone's): untouchable, for so
        // long.
        const d = domeOver(townSave.x, townSave.z, now);
        buffBox.current.style.display = d ? "" : "none";
        const text = d ? `Dome · ${Math.ceil((d.until - now) / 1000)}s` : "";
        if (d && buffBox.current.textContent !== text)
          buffBox.current.textContent = text;
      }
      if (hasteBox.current) {
        const h = buffOn(bossFight.you, "haste", now);
        hasteBox.current.style.display = h ? "" : "none";
        const text = h
          ? `Haste +${Math.round(h.value * 100)}% · ${Math.ceil((h.until - now) / 1000)}s`
          : "";
        if (h && hasteBox.current.textContent !== text)
          hasteBox.current.textContent = text;
      }
      if (shuffleBox.current) {
        const s = buffOn(bossFight.you, "shuffle", now);
        shuffleBox.current.style.display = s ? "" : "none";
        const n = s ? Math.round(s.value) : 0;
        const text = s
          ? `Shuffle ${n} ${n === 1 ? "bounce" : "bounces"} · ${Math.ceil((s.until - now) / 1000)}s`
          : "";
        if (s && shuffleBox.current.textContent !== text)
          shuffleBox.current.textContent = text;
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
        ref={hasteBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-[#5ef0ff]"
        style={{ display: "none" }}
      />
      <div
        ref={shuffleBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-[#c9a7ff]"
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
      // Your Rimshot winding up comes before either.
      const slam = pendingSlam(you ?? -1);
      const wind =
        slam && now < slam.dueAt
          ? { from: slam.castAt, until: slam.dueAt }
          : undefined;
      const ch = wind ?? (mine && now < mine.until ? mine : saving);
      const kind = wind
        ? "slam"
        : ch === mine && ch
          ? "mine"
          : ch
            ? "saving"
            : "";
      if (box.current && label.current && fill.current) {
        box.current.style.display = ch ? "" : "none";
        if (kind !== shown) {
          shown = kind;
          label.current.textContent =
            kind === "slam"
              ? "Rimshot"
              : kind === "mine"
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
