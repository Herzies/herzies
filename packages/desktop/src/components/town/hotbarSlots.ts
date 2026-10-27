import { useSyncExternalStore } from "react";

// The Town hotbar: four slots on keys 1-4, each holding a consumable by
// item id (a stack, not a copy), eaten by pressing its key, or one of your
// class skills (skillSlot(n): the class's nth, whichever it is), used by
// pressing it. Filled from the slot itself or the bank's right-click menu.
// Kept in localStorage, per device, like the "!"s (met.ts): a slot that
// comes back empty on a new machine is harmless.

/** The keys, in order: one slot each. */
export const HOTBAR_KEYS = ["1", "2", "3", "4"] as const;
export type HotbarKey = (typeof HOTBAR_KEYS)[number];
export type Hotbar = Record<HotbarKey, string | null>;

/** A slot's value for your class's `n`th skill (1-based). */
export function skillSlot(n: number): string {
  return `skill:${n}`;
}

/** Which of your class's skills a slot holds (1-based), or null if it
 * holds something else. */
export function skillOfSlot(value: string | null): number | null {
  if (value === LEGACY_SKILL_SLOT) return 1;
  const m = value?.match(/^skill:(\d)$/);
  return m ? Number(m[1]) : null;
}

/** How the one class skill was saved before classes had two. */
const LEGACY_SKILL_SLOT = "skill";
/** How many skills a class may have (a Bard's third, Haste, at level 15). */
export const MAX_CLASS_SKILLS = 3;

const STORAGE_KEY = "herzies.town.hotbar";
/** The first skill starts on 1, where it always was; the second beside it. */
const DEFAULT: Hotbar = {
  "1": skillSlot(1),
  "2": skillSlot(2),
  "3": null,
  "4": null,
};

const listeners = new Set<() => void>();

function load(): Hotbar {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const out = { ...DEFAULT };
    for (const k of HOTBAR_KEYS) {
      // A slot saved before it existed (1, from the three-slot bar) keeps
      // its default; one saved empty stays empty.
      if (raw && k in raw) out[k] = typeof raw[k] === "string" ? raw[k] : null;
      if (out[k] === LEGACY_SKILL_SLOT) out[k] = skillSlot(1);
    }
    // Saved before classes had a second skill: it goes in the first empty
    // slot (once; moved or cleared after that, it stays as it's put).
    if (raw && !raw.v2) {
      const free = HOTBAR_KEYS.find((k) => out[k] === null);
      if (!HOTBAR_KEYS.some((k) => out[k] === skillSlot(2)) && free)
        out[free] = skillSlot(2);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...out, v2: true }));
    }
    return out;
  } catch {
    return { ...DEFAULT };
  }
}

let slots = load();

/** Skills already put on the bar once on being learned (see
 * offerSkillSlot), so one moved off it isn't put back. */
let offered = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return new Set<number>(Array.isArray(raw?.offered) ? raw.offered : []);
  } catch {
    return new Set<number>();
  }
})();

/** A skill just learned (your class's `n`th, past the first two): onto the
 * first empty slot, once. */
export function offerSkillSlot(n: number): void {
  if (n <= 2 || offered.has(n)) return;
  offered = new Set([...offered, n]);
  const free = HOTBAR_KEYS.find((k) => slots[k] === null);
  if (free && !HOTBAR_KEYS.some((k) => slots[k] === skillSlot(n)))
    slots = { ...slots, [free]: skillSlot(n) };
  save();
}

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...slots, v2: true, offered: [...offered] }),
    );
  } catch {
    // Private mode or full: the slots last until the app closes.
  }
  for (const l of listeners) l();
}

/** Put `itemId` (or a skillSlot) on `key`. One thing sits in one slot:
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
