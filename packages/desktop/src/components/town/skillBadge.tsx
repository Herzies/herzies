import {
  CLASS_DEFS,
  CLASS_IDS,
  type HerzieClass,
  type SkillId,
} from "@herzies/shared";
import { cn } from "../../lib/utils";

/** A skill's letters, until skills have icons: on its badge (the Skills
 * window) and its hotbar slot. */
export const SKILL_ABBR: Record<SkillId, string> = {
  backspin: "BS",
  "soothing-drones": "SD",
  cymbrella: "CB",
  resurrect: "RZ",
  taunt: "TA",
  haste: "HS",
  shuffle: "SH",
  rimshot: "RS",
  "cymbal-trap": "CT",
  multispin: "MS",
  rage: "RG",
  focus: "FC",
  "forbidden-frequency": "FF",
  silencio: "SI",
};

/** Each class's colour, for its skills' letters. */
const CLASS_COLOURS: Record<HerzieClass, { text: string; badge: string }> = {
  bard: { text: "text-green", badge: "border-green/70 bg-green/15" },
  record_slinger: { text: "text-blue", badge: "border-blue/70 bg-blue/15" },
  percussionist: {
    text: "text-yellow",
    badge: "border-yellow/70 bg-yellow/15",
  },
};

function classOfSkill(id: SkillId): HerzieClass | undefined {
  return CLASS_IDS.find((c) => CLASS_DEFS[c].skills.includes(id));
}

/** The text colour of a skill's letters: its class's. */
export function skillTextColour(id: SkillId): string {
  const c = classOfSkill(id);
  return c ? CLASS_COLOURS[c].text : "text-white";
}

/** A skill's letters in a box of its class's colour. */
export function SkillBadge({
  id,
  className,
}: {
  id: SkillId;
  className?: string;
}) {
  const c = classOfSkill(id);
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded border text-[11px] font-bold",
        c
          ? cn(CLASS_COLOURS[c].badge, CLASS_COLOURS[c].text)
          : "border-white/20",
        className,
      )}
    >
      {SKILL_ABBR[id]}
    </span>
  );
}
