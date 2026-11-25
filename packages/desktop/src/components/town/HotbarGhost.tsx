import { getItem, ItemTypeIcon } from "@herzies/shared";
import { createPortal } from "react-dom";
import { SwapIcon } from "../icons/SwapIcon";
import { mySkillAt } from "./combat/skills";
import type { HotbarGhostAt } from "./hotbarDrop";
import { loadoutOfSlot, skillOfSlot } from "./hotbarSlots";
import { SkillBadge } from "./skillBadge";

/** What's carried to the hotbar (useDragToHotbar's `ghost`), under the
 * cursor, as it will look on its slot. */
export function HotbarGhost({ ghost }: { ghost: HotbarGhostAt | null }) {
  if (!ghost) return null;
  const { value } = ghost;
  const n = skillOfSlot(value);
  const skill = n !== null ? mySkillAt(n) : null;
  const loadout = loadoutOfSlot(value);
  const item = n === null && loadout === null ? getItem(value) : undefined;
  return createPortal(
    <div
      className="pointer-events-none fixed z-200 -translate-x-1/2 -translate-y-1/2"
      style={{ left: ghost.x, top: ghost.y }}
    >
      {skill ? (
        <div className="rounded bg-black/70">
          <SkillBadge id={skill.id} />
        </div>
      ) : (
        <div className="flex size-9 items-center justify-center rounded border border-white/40 bg-black/70 text-[11px] font-bold text-cyan">
          {loadout === "swap" ? (
            <SwapIcon className="size-5" />
          ) : loadout !== null ? (
            `L${loadout}`
          ) : item ? (
            <ItemTypeIcon item={item} className="size-6" />
          ) : (
            "—"
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
