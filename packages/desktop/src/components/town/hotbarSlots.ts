import { useSyncExternalStore } from "react";

// The Town hotbar: four slots on keys 1-4, each holding a consumable by
// item id (a stack, not a copy), eaten by pressing its key, or your class
// skill (SKILL_SLOT), used by pressing it. Filled from the slot itself or
// the bank's right-click menu. Kept in localStorage, per device, like the
// "!"s (met.ts): a slot that comes back empty on a new machine is harmless.

/** The keys, in order: one slot each. */
export const HOTBAR_KEYS = ["1", "2", "3", "4"] as const;
export type HotbarKey = (typeof HOTBAR_KEYS)[number];
export type Hotbar = Record<HotbarKey, string | null>;

/** A slot's value for your class skill (whichever it is: a class has one). */
export const SKILL_SLOT = "skill";

const STORAGE_KEY = "herzies.town.hotbar";
/** The class skill starts on 1, where it always was. */
const DEFAULT: Hotbar = { "1": SKILL_SLOT, "2": null, "3": null, "4": null };

const listeners = new Set<() => void>();

function load(): Hotbar {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const out = { ...DEFAULT };
    for (const k of HOTBAR_KEYS) {
      // A slot saved before it existed (1, from the three-slot bar) keeps
      // its default; one saved empty stays empty.
      if (raw && k in raw) out[k] = typeof raw[k] === "string" ? raw[k] : null;
    }
    return out;
  } catch {
    return { ...DEFAULT };
  }
}

let slots = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  } catch {
    // Private mode or full: the slots last until the app closes.
  }
  for (const l of listeners) l();
}

/** Put `itemId` (or SKILL_SLOT) on `key`. One thing sits in one slot:
 * assigning it again moves it there. */
export function assignHotbar(key: HotbarKey, itemId: string): void {
  const next = { ...slots };
  for (const k of HOTBAR_KEYS) if (next[k] === itemId) next[k] = null;
  next[key] = itemId;
  slots = next;
  save();
}

/** Empty `key`. */
export function clearHotbar(key: HotbarKey): void {
  if (slots[key] === null) return;
  slots = { ...slots, [key]: null };
  save();
}

/** What's on `key` now. */
export function hotbarItem(key: HotbarKey): string | null {
  return slots[key];
}

export function useHotbar(): Hotbar {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => slots,
  );
}
