import { SKILL_DEFS, type SkillId } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { bossFight } from "./combat/fight";
import { buffOn, skillPercent, skills, useSkills } from "./combat/skills";

const SKILL_ICONS: Record<SkillId, string> = {
  "soothing-drones": "💓",
  backspin: "📀",
  cymbrella: "🥁",
};

/** How long a level-up stays up, ms. */
const LEVEL_UP_MS = 3_500;

/**
 * Your class skill, bottom centre while you can fight: what it is, its
 * key, its level, and a sweep while it cools down. A Cymbrella you're
 * under counts down beside it; a level-up is announced over it.
 */
export function SkillHud() {
  useSkills();
  const mine = skills.mine;
  const sweep = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const buffBox = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  // The sweep and the seconds left run off the frame clock, not renders.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const id = skills.mine?.id;
      if (id && sweep.current && label.current) {
        const left = Math.max(0, skills.readyAt - now);
        const f = left / SKILL_DEFS[id].cooldownMs;
        sweep.current.style.background =
          f > 0
            ? `conic-gradient(rgba(0,0,0,0.65) ${f * 360}deg, transparent 0)`
            : "transparent";
        label.current.textContent = f > 0 ? String(Math.ceil(left / 1000)) : "";
      }
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

  // Clear the level-up after a while.
  const levelUp = skills.levelUp;
  useEffect(() => {
    if (!levelUp) return;
    const t = setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, levelUp.at + LEVEL_UP_MS - performance.now()),
    );
    return () => clearTimeout(t);
  }, [levelUp]);

  if (!mine) return null;
  const def = SKILL_DEFS[mine.id];
  const showLevelUp =
    levelUp && performance.now() - levelUp.at < LEVEL_UP_MS ? levelUp : null;

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1">
      {showLevelUp ? (
        <div className="rounded bg-black/70 px-2 py-0.5 text-ui text-yellow">
          Leveled up "{SKILL_DEFS[showLevelUp.skill].name}" to Lv.{" "}
          {showLevelUp.level}
        </div>
      ) : null}
      <div
        ref={buffBox}
        className="rounded bg-black/60 px-1.5 text-[11px] text-yellow"
        style={{ display: "none" }}
      />
      <div
        className={cn(
          "relative flex h-11 w-11 items-center justify-center overflow-hidden rounded border border-white/30 bg-black/55 text-xl",
        )}
        title={`${def.name} (Lv. ${mine.level}): ${skillPercent(mine.id, mine.level)}%`}
      >
        <span aria-hidden>{SKILL_ICONS[mine.id]}</span>
        <div ref={sweep} className="absolute inset-0" />
        <span
          ref={label}
          className="absolute inset-0 flex items-center justify-center text-ui font-bold text-white"
        />
        <span className="absolute top-0 left-0.5 text-[9px] font-bold text-white/80">
          Q
        </span>
        <span className="absolute right-0.5 bottom-0 text-[9px] text-white/70">
          {mine.level}
        </span>
      </div>
      <div className="text-[10px] text-white/60">{def.name}</div>
    </div>
  );
}
