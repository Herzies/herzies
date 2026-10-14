import { SKILL_DEFS } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { bossFight } from "./combat/fight";
import { buffOn, skillPercent, skills, useSkills } from "./combat/skills";
import { Key } from "./Key";

/** How long a level-up stays up, ms. */
const LEVEL_UP_MS = 3_500;

/**
 * Your class skill, anywhere in the Town: just its name. Used, the name
 * greys out and fills back to white from the left as it cools down, with
 * the seconds left over it. Dimmed where it can't be used (only where you
 * can fight). A Cymbrella you're under counts down beside it; a level-up is
 * announced over it.
 */
export function SkillHud({
  usable = true,
  className = "bottom-3 right-2",
}: {
  usable?: boolean;
  /** Where it sits: absolute-positioning classes. */
  className?: string;
}) {
  useSkills();
  const mine = skills.mine;
  /** The white copy of the name, revealed from the left as it cools. */
  const fill = useRef<HTMLSpanElement>(null);
  /** Seconds left, over the name. */
  const label = useRef<HTMLSpanElement>(null);
  const buffBox = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  // The fill and the seconds left run off the frame clock, not renders.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const id = skills.mine?.id;
      if (id && fill.current && label.current) {
        const left = Math.max(0, skills.readyAt - now);
        const f = Math.min(1, left / SKILL_DEFS[id].cooldownMs);
        fill.current.style.clipPath = `inset(0 ${f * 100}% 0 0)`;
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
    <div
      className={cn(
        "pointer-events-none absolute z-30 flex flex-col items-center gap-1",
        className,
      )}
    >
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
          // The "Tab aim" hint's look. mt-4: room above for the seconds
          // left, clear of the Cymbrella.
          "pointer-events-auto mt-4 flex items-center gap-2 rounded bg-black/55 px-2 py-1 text-[10px] whitespace-nowrap",
          !usable && "opacity-45",
        )}
        title={
          usable
            ? `${def.name} (Lv. ${mine.level}): ${skillPercent(mine.id, mine.level)}%`
            : `${def.name}: usable on the training grounds and in the cave`
        }
      >
        {/* The key and the name centred on each other. The key's line is
            13px so, with its border, it's the 15px of the text's line and
            the box stays the Tab hint's height. */}
        <span className="inline-flex items-center gap-1.5">
          <Key className="leading-[13px]">Q</Key>
          <span className="relative">
            {/* Grey underneath; the white copy over it is clipped back to
                the cooldown's progress. */}
            <span className="text-white/35">{def.name}</span>
            <span
              ref={fill}
              aria-hidden
              className="absolute inset-0 whitespace-nowrap text-white/80"
            >
              {def.name}
            </span>
            <span
              ref={label}
              className="absolute bottom-full left-1/2 -translate-x-1/2 pb-1.5 text-[10px] text-white"
            />
          </span>
        </span>
      </div>
    </div>
  );
}
