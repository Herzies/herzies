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
 * The Skills window: the class, and each skill it knows — its letters in
 * its class's colour (dragged onto a hotbar slot, the skill goes there),
 * its level, what it does now, its cooldown, and how far to the next level.
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
  const rank = (id: string) => def.skills.indexOf(id as SkillId);
  // In the class's order, as the hotbar counts them (skillSlot).
  const known = skills
    .filter((s) => isSkillId(s.skillId))
    .sort((a, b) => rank(a.skillId) - rank(b.skillId));
  const drag = useDragToHotbar();
  return (
    <div className="flex flex-col gap-2 pt-1.5 pb-4">
      <div className="flex items-baseline justify-between text-ui">
        <span className="font-bold text-text">{def.name}</span>
        <span className="text-text-dim">{CLASS_ROLE_LABELS[def.role]}</span>
      </div>
      {known.length === 0 ? (
        <div className="text-ui text-text-dim">No skills yet.</div>
      ) : (
        known.map((s, i) => (
          <SkillRow
            key={s.skillId}
            skill={s}
            onGrab={(e) => drag.start(skillSlot(i + 1), e)}
          />
        ))
      )}
      {def.skills
        .filter(
          (id) =>
            SKILL_DEFS[id].minLevel && !known.some((s) => s.skillId === id),
        )
        .map((id) => (
          <LockedRow key={id} id={id} />
        ))}
      <HotbarGhost ghost={drag.ghost} />
    </div>
  );
}

/** A skill the class learns later: what it'll do, and when. */
function LockedRow({ id }: { id: SkillId }) {
  const def = SKILL_DEFS[id];
  return (
    <div className="flex gap-2 border border-white/10 px-2 py-1.5 opacity-60">
      <SkillBadge id={id} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between text-ui">
          <span className="font-bold text-text-dim">{def.name}</span>
          <span className="text-text-dim">Learned at level {def.minLevel}</span>
        </div>
        <div className="text-ui text-text-dim">{describeSkill(id, 1)}</div>
      </div>
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
    <div className="flex gap-2 border border-white/15 px-2 py-1.5">
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
        <div className="text-ui text-text">
          {describeSkill(skill.skillId, skill.level)}
        </div>
        <div className="text-ui text-text-dim">
          {def.cooldownMs / 1000}s cooldown
          {def.durationMs ? ` · lasts ${def.durationMs / 1000}s` : ""}
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
  );
}
