import { getItem, type LoadoutIndex } from "@herzies/shared";
import { notify } from "../../lib/notices";
import { queueSkill } from "./combat/skills";
import { eat } from "./eat";
import { HOTBAR_SLOT_ATTR } from "./hotbarDrop";
import { hotbarItem, loadoutOfSlot, skillOfSlot } from "./hotbarSlots";

/** What the hotbar can't do on its own: wearing a card and switching
 * loadouts are the Deck's (InventoryView, always mounted, provides them). */
export interface HotbarHandlers {
  /** Take off the worn copy of `itemId`, or put one on from the bag (or the
   * other loadout), in the loadout you're on. `from`: where its card takes
   * off, the slot pressed. */
  toggleCard: (itemId: string, from?: { x: number; y: number }) => void;
  switchLoadout: (to: LoadoutIndex) => void;
  /** The loadout worn now. */
  activeLoadout: () => LoadoutIndex | null;
}

let handlers: HotbarHandlers | null = null;

/** Hands the hotbar its handlers until the returned function is called. */
export function provideHotbarHandlers(h: HotbarHandlers): () => void {
  handlers = h;
  return () => {
    if (handlers === h) handlers = null;
  };
}

function slotCentre(i: number) {
  const r = document
    .querySelector(`[${HOTBAR_SLOT_ATTR}="${i}"]`)
    ?.getBoundingClientRect();
  return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Slot `i` pressed (its key, or a click): a skill is used, a consumable
 * eaten, a card put on or taken off, a loadout switched to (not within
 * LOADOUT_COOLDOWN_MS of the last switch: useLoadoutSwitch). Returns whether
 * the slot held anything. */
export function pressHotbarSlot(i: number): boolean {
  const value = hotbarItem(i);
  if (!value) return false;
  const skill = skillOfSlot(value);
  if (skill !== null) {
    queueSkill(skill);
    return true;
  }
  const loadout = loadoutOfSlot(value);
  if (loadout !== null) {
    const active = handlers?.activeLoadout();
    if (!handlers || !active) return true;
    if (loadout === "swap") {
      handlers.switchLoadout(active === 1 ? 2 : 1);
      return true;
    }
    if (active === loadout) {
      notify(`Loadout ${loadout} is already on`, { kind: "info" });
      return true;
    }
    handlers.switchLoadout(loadout);
    return true;
  }
  const item = getItem(value);
  if (item?.consumable) void eat(value);
  else if (item?.equipable) handlers?.toggleCard(value, slotCentre(i));
  return true;
}
