import {
  CLASS_DEFS,
  CLASS_ROLE_LABELS,
  describeSkill,
  type HerzieClass,
  type HerzieSkill,
  isSkillId,
  SKILL_DEFS,
  SKILL_MAX_LEVEL,
  skillLevelProgress,
  skillTotalXpForLevel,
  skillXpForLevel,
} from "@herzies/shared";
import { SquareBar } from "./SquareBar";

/**
 * The Herzie view's Skills tab: the class, and each skill it knows — its
 * level, what it does now, its cooldown, and how far to the next level.
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
  const known = skills.filter((s) => isSkillId(s.skillId));
  return (
    <div className="flex flex-col gap-2 pt-1.5 pb-4">
      <div className="flex items-baseline justify-between text-ui">
        <span className="font-bold text-text">{def.name}</span>
        <span className="text-text-dim">{CLASS_ROLE_LABELS[def.role]}</span>
      </div>
      {known.length === 0 ? (
        <div className="text-ui text-text-dim">No skills yet.</div>
      ) : (
        known.map((s) => <SkillRow key={s.skillId} skill={s} />)
      )}
    </div>
  );
}

function SkillRow({ skill }: { skill: HerzieSkill }) {
  if (!isSkillId(skill.skillId)) return null;
  const def = SKILL_DEFS[skill.skillId];
  const maxed = skill.level >= SKILL_MAX_LEVEL;
  const into = Math.max(
    0,
    Math.floor(skill.xp - skillTotalXpForLevel(skill.level)),
  );
  const need = skillXpForLevel(skill.level);
  return (
    <div className="border border-border px-2 py-1.5">
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
  );
}
