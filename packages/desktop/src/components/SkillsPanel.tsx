import {
  CLASS_DEFS,
  CLASS_ROLE_LABELS,
  describeSkill,
  type HerzieClass,
  type HerzieSkill,
  isSkillId,
  SKILL_DEFS,
  SKILL_MAX_LEVEL,
  type SkillId,
  skillLearnedAt,
  skillLevelProgress,
  skillTotalXpForLevel,
  skillXpForLevel,
} from "@herzies/shared";
import { SquareBar } from "./SquareBar";
import { Tooltip } from "./Tooltip";
import { HotbarGhost } from "./town/HotbarGhost";
import { useDragToHotbar } from "./town/hotbarDrop";
import { skillSlot } from "./town/hotbarSlots";
import { SkillBadge } from "./town/skillBadge";

/**
 * The Skills window: the class, and every skill it has, in the class's
 * order. One it knows: its letters in its class's colour (dragged onto a
 * hotbar slot, the skill goes there), its level, what it does now, its
 * cooldown, the herzie level it's learned at, and how far to the next
 * level. One it doesn't yet: dimmed, what it'll do, and what unlocks it.
 * Skills level by being used in boss fights, so there's nothing to do here
 * but look.
 */
export function SkillsPanel({
  herzieClass,
  skills,
}: {
  herzieClass: HerzieClass;
  skills: readonly HerzieSkill[];
}) {
  const def = CLASS_DEFS[herzieClass];
  const known = new Map(
    skills.filter((s) => isSkillId(s.skillId)).map((s) => [s.skillId, s]),
  );
  // Hotbar slots count the known skills in the class's order (skillSlot).
  const slots = def.skills.filter((id) => known.has(id));
  const drag = useDragToHotbar();
  return (
    <div className="flex flex-col gap-2 pt-1.5 pb-4">
      <div className="flex items-baseline justify-between text-ui">
        <span className="font-bold text-text">{def.name}</span>
        <span className="text-text-dim">{CLASS_ROLE_LABELS[def.role]}</span>
      </div>
      {def.skills.map((id) => {
        const s = known.get(id);
        return s ? (
          <SkillRow
            key={id}
            skill={s}
            onGrab={(e) => drag.start(skillSlot(slots.indexOf(id) + 1), e)}
          />
        ) : (
          <LockedRow key={id} id={id} />
        );
      })}
      <HotbarGhost ghost={drag.ghost} />
    </div>
  );
}

/** What unlocks a skill: "Level 20", and the skill level it needs too, if
 * any ("Level 20 • Rimshot level 5"). */
function unlockText(id: SkillId): string {
  const needs = SKILL_DEFS[id].requires;
  return `Level ${skillLearnedAt(id)}${
    needs ? ` • ${SKILL_DEFS[needs.skill].name} level ${needs.level}` : ""
  }`;
}

/** A skill's description and its timings, smaller than its name. */
function SkillBody({ id, level }: { id: SkillId; level: number }) {
  const def = SKILL_DEFS[id];
  return (
    <>
      <div className="mt-0.5 text-[10px] leading-tight">
        {describeSkill(id, level)}
      </div>
      <div className="mt-0.5 text-[10px] leading-tight text-text-dim">
        {def.cooldownMs / 1000}s cooldown
        {def.durationMs ? ` · lasts ${def.durationMs / 1000}s` : ""}
      </div>
    </>
  );
}

/** A skill's footer, the width of its box under a rule: what it requires
 * (met or not). */
function SkillFooter({ id }: { id: SkillId }) {
  return (
    <div className="border-t border-inherit px-2 py-1 text-[10px] leading-tight text-text-dim">
      Requires: {unlockText(id)}
    </div>
  );
}

/** A skill the class learns later: what it'll do, and what unlocks it. */
function LockedRow({ id }: { id: SkillId }) {
  const def = SKILL_DEFS[id];
  return (
    <div
      aria-disabled
      className="border border-white/10 text-text-dim opacity-50 grayscale"
    >
      <div className="flex gap-2 px-2 py-1.5">
        <SkillBadge id={id} />
        <div className="min-w-0 flex-1">
          <div className="text-ui font-bold">{def.name}</div>
          <SkillBody id={id} level={1} />
        </div>
      </div>
      <SkillFooter id={id} />
    </div>
  );
}

function SkillRow({
  skill,
  onGrab,
}: {
  skill: HerzieSkill;
  /** Pointer down on the badge: the start of a drag to the hotbar. */
  onGrab: (e: React.PointerEvent) => void;
}) {
  if (!isSkillId(skill.skillId)) return null;
  const def = SKILL_DEFS[skill.skillId];
  const maxed = skill.level >= SKILL_MAX_LEVEL;
  const into = Math.max(
    0,
    Math.floor(skill.xp - skillTotalXpForLevel(skill.level)),
  );
  const need = skillXpForLevel(skill.level);
  return (
    <div className="border border-white/15">
      <div className="flex gap-2 px-2 py-1.5">
        <Tooltip label="Drag onto a hotbar slot">
          <button
            type="button"
            aria-label={`${def.name}: drag onto a hotbar slot`}
            onPointerDown={onGrab}
            className="h-fit cursor-grab touch-none border-none bg-transparent p-0"
          >
            <SkillBadge id={skill.skillId} />
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between text-ui">
            <span className="font-bold text-purple">{def.name}</span>
            <span className="text-text-dim">
              Lv. {skill.level}
              {maxed ? " (max)" : ` / ${SKILL_MAX_LEVEL}`}
            </span>
          </div>
          <div className="text-text">
            <SkillBody id={skill.skillId} level={skill.level} />
          </div>
          <SquareBar
            label="exp:"
            progress={skillLevelProgress(skill)}
            tip={
              maxed
                ? "Max level"
                : `${into} / ${need} exp to Lv. ${skill.level + 1}`
            }
            fill="bg-green"
            ariaLabel={`${def.name} experience`}
            ariaMax={maxed ? 1 : need}
            ariaNow={maxed ? 1 : into}
            className="mt-1 text-text-dim"
          />
        </div>
      </div>
      <SkillFooter id={skill.skillId} />
    </div>
  );
}
