import { useSyncExternalStore } from "react";

// The Town hotbar: three slots, each holding a consumable by item id (a
// stack, not a copy), eaten by pressing its key. Key 1 stays the class
// skill, so the slots are on 2, 3 and 4. Assigned from the bank's
// right-click menu. Kept in localStorage, per device, like the "!"s
// (met.ts): a slot that comes back empty on a new machine is harmless.

/** The keys, in order: one slot each. */
export const HOTBAR_KEYS = ["2", "3", "4"] as const;
export type HotbarKey = (typeof HOTBAR_KEYS)[number];
export type Hotbar = Record<HotbarKey, string | null>;

const STORAGE_KEY = "herzies.town.hotbar";
const EMPTY: Hotbar = { "2": null, "3": null, "4": null };

const listeners = new Set<() => void>();

function load(): Hotbar {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const out = { ...EMPTY };
    for (const k of HOTBAR_KEYS)
      if (typeof raw?.[k] === "string") out[k] = raw[k];
    return out;
  } catch {
    return { ...EMPTY };
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

/** Put `itemId` on `key`. One item sits in one slot: assigning it again
 * moves it there. */
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
