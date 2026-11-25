import type { LoadoutIndex } from "@herzies/shared";
import { useSyncExternalStore } from "react";

// The Town hotbar: eight slots, each on keys of your choosing (hotbarKeys.ts),
// holding one of:
//  - an item by id (a stack, not a copy): a consumable is eaten, a card you
//    can wear is put on or taken off in the loadout you're on;
//  - one of your class skills (skillSlot(n): the class's nth, whichever it
//    is), used;
//  - a loadout (loadoutSlot(n)), switched to, or the swap between the two
//    (loadoutSlot("swap")), switching to whichever isn't on.
// Filled from the slot itself, the bank's right-click menu, or by dragging a
// card, a loadout tab or a skill's badge onto it; dragged between slots, two
// swap, and dragged off the bar, a slot empties. Kept in localStorage, per
// device, like the "!"s (met.ts): a slot that comes back empty on a new
// machine is harmless.

/** How many slots the bar has. */
export const HOTBAR_SIZE = 8;
/** What's in each slot, by index. */
export type HotbarSlots = readonly (string | null)[];

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

/** Where a loadout slot switches to: loadout 1 or 2, or whichever isn't on. */
export type LoadoutTarget = LoadoutIndex | "swap";

/** A slot's value for switching to `target`. */
export function loadoutSlot(target: LoadoutTarget): string {
  return `loadout:${target}`;
}

/** Where a slot switches loadouts to, or null if it holds something else. */
export function loadoutOfSlot(value: string | null): LoadoutTarget | null {
  if (value === "loadout:1") return 1;
  if (value === "loadout:2") return 2;
  if (value === "loadout:swap") return "swap";
  return null;
}

/** How the one class skill was saved before classes had two. */
const LEGACY_SKILL_SLOT = "skill";

const STORAGE_KEY = "herzies.town.hotbar";
/** The first skill starts on the first slot, the second beside it. */
const DEFAULT: HotbarSlots = [
  skillSlot(1),
  skillSlot(2),
  ...Array<null>(HOTBAR_SIZE - 2).fill(null),
];

const listeners = new Set<() => void>();

/** The four-slot bar as it was saved before it had eight: by key "1"-"4". A
 * slot saved before it existed (1, from the three-slot bar) keeps its
 * default; one saved empty stays empty. Saved before classes had a second
 * skill (no `v2`), that one goes in the first empty slot. */
function fromFourSlots(raw: Record<string, unknown>): (string | null)[] {
  const out = [...DEFAULT];
  for (let i = 0; i < 4; i++) {
    const k = String(i + 1);
    const v = raw[k];
    if (k in raw) out[i] = typeof v === "string" ? v : null;
    if (out[i] === LEGACY_SKILL_SLOT) out[i] = skillSlot(1);
  }
  if (!raw.v2 && !out.includes(skillSlot(2))) {
    const free = out.indexOf(null);
    if (free !== -1) out[free] = skillSlot(2);
  }
  return out;
}

function load(): { slots: HotbarSlots; offered: Set<number> } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const offered = new Set<number>(
      Array.isArray(raw?.offered) ? raw.offered : [],
    );
    if (!raw || typeof raw !== "object") return { slots: DEFAULT, offered };
    if (!Array.isArray(raw.slots))
      return { slots: fromFourSlots(raw), offered };
    const slots = Array.from({ length: HOTBAR_SIZE }, (_, i) =>
      typeof raw.slots[i] === "string" ? (raw.slots[i] as string) : null,
    );
    return { slots, offered };
  } catch {
    return { slots: DEFAULT, offered: new Set() };
  }
}

let { slots, offered } = load();

/** A skill just learned (your class's `n`th, past the first two): onto the
 * first empty slot, once, so one moved off it isn't put back. */
export function offerSkillSlot(n: number): void {
  if (n <= 2 || offered.has(n)) return;
  offered = new Set([...offered, n]);
  const free = slots.indexOf(null);
  if (free !== -1 && !slots.includes(skillSlot(n))) {
    const next = [...slots];
    next[free] = skillSlot(n);
    slots = next;
  }
  save();
}

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ slots, offered: [...offered] }),
    );
  } catch {
    // Private mode or full: the slots last until the app closes.
  }
  for (const l of listeners) l();
}

/** Put `value` (an item id, a skillSlot or a loadoutSlot) on slot `i`. One
 * thing sits in one slot: assigning it again moves it there. */
export function assignHotbar(i: number, value: string): void {
  const next = slots.map((v) => (v === value ? null : v));
  next[i] = value;
  slots = next;
  save();
}

/** Put `value` on the first empty slot (staying where it is if it's on the
 * bar already). Returns whether it's on the bar: false when the bar's full. */
export function addToHotbar(value: string): boolean {
  if (slots.includes(value)) return true;
  const free = slots.indexOf(null);
  if (free === -1) return false;
  assignHotbar(free, value);
  return true;
}

/** Empty slot `i`. */
export function clearHotbar(i: number): void {
  if (slots[i] === null) return;
  const next = [...slots];
  next[i] = null;
  slots = next;
  save();
}

/** Swap slots `a` and `b` (one may be empty: a move). */
export function swapHotbar(a: number, b: number): void {
  if (a === b) return;
  const next = [...slots];
  [next[a], next[b]] = [next[b], next[a]];
  slots = next;
  save();
}

/** What's on slot `i` now. */
export function hotbarItem(i: number): string | null {
  return slots[i] ?? null;
}

export function useHotbar(): HotbarSlots {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => slots,
  );
}
