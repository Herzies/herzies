import { useSyncExternalStore } from "react";
import { HOTBAR_SIZE } from "./hotbarSlots";

// Which keys press each hotbar slot (hotbarSlots.ts): two per slot, a key and
// a second one. 1-8 to begin with, and Q on the first slot too (where your
// first class skill starts); set in Settings > Controls. By
// `KeyboardEvent.code`, the key's place on the keyboard (as walking is:
// town/input.ts), with the label it printed when it was bound, so a Norwegian
// "ø" shows as "ø" rather than ";". Kept in localStorage, per device.

export interface HotbarBinding {
  code: string;
  /** What's printed on the key, for the slot's corner. */
  label: string;
}
/** A slot's two keys: its key and a second one; null where there's none. */
export type HotbarKeyPair = readonly [
  HotbarBinding | null,
  HotbarBinding | null,
];
/** Each slot's keys, by slot. */
export type HotbarBindings = readonly HotbarKeyPair[];

const digit = (n: number): HotbarBinding => ({
  code: `Digit${n}`,
  label: String(n),
});
const DEFAULT: HotbarBindings = Array.from({ length: HOTBAR_SIZE }, (_, i) =>
  i === 0 ? [digit(1), { code: "KeyQ", label: "Q" }] : [digit(i + 1), null],
);

/** Keys the game already answers to, and what for: never a hotbar key. The
 * view keys are main.tsx's shortcuts; walking and the camera town/input.ts;
 * aiming, firing and the stance combat/Combat.tsx. */
export const RESERVED_KEYS: Readonly<Record<string, string>> = {
  KeyW: "walking",
  KeyA: "walking",
  KeyS: "walking",
  KeyD: "walking",
  Space: "hopping",
  ShiftLeft: "running",
  ShiftRight: "running",
  ArrowUp: "the camera",
  ArrowDown: "the camera",
  ArrowLeft: "the camera",
  ArrowRight: "the camera",
  KeyE: "talking and using things",
  KeyR: "the lute's stance",
  KeyF: "firing while aiming, and Social",
  Tab: "aiming",
  Escape: "closing windows",
  Enter: "the chat",
  KeyC: "the chat",
  KeyH: "Home",
  KeyT: "World",
  KeyM: "the menu",
  KeyO: "your profile",
  KeyI: "the deck",
  KeyB: "the bag",
  KeyJ: "stats",
  KeyK: "skills",
  KeyL: "the leaderboard",
  KeyU: "quests",
  KeyP: "the premium shop",
  KeyZ: "the bigger Town window",
};

/** Every key a slot may take: the digits, the letters nothing else uses, and
 * the punctuation keys. */
const BINDABLE = new Set([
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "KeyG",
  "KeyN",
  "KeyQ",
  "KeyV",
  "KeyX",
  "KeyY",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "IntlBackslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
]);

/** Why `code` can't be a hotbar key ("is taken by the bag"), or null if it
 * can. */
export function hotbarKeyRefusal(code: string): string | null {
  const use = RESERVED_KEYS[code];
  if (use) return `is taken by ${use}`;
  return BINDABLE.has(code) ? null : "can't be used";
}

/** A pressed key's label: the character it types, upper-cased ("Num 1" on
 * the number pad, apart from the row's "1"), or its code shortened for one
 * that types nothing printable. */
export function keyLabel(e: Pick<KeyboardEvent, "key" | "code">): string {
  if (e.code.startsWith("Numpad")) return `Num ${e.code.slice(6)}`;
  if (e.key.length === 1 && e.key !== " ") return e.key.toUpperCase();
  return e.code.replace(/^(Key|Digit)/, "");
}

/** A slot's keys as its corner shows them: "1/Q", "2", or null for none. */
export function slotKeysLabel(pair: HotbarKeyPair | undefined): string | null {
  const labels = (pair ?? []).flatMap((b) => (b ? [b.label] : []));
  return labels.length ? labels.join("/") : null;
}

const STORAGE_KEY = "herzies.town.hotbarKeys";
const listeners = new Set<() => void>();

/** A saved key: null for one saved empty, undefined for one unreadable. */
function parse(b: unknown): HotbarBinding | null | undefined {
  if (b === null) return null;
  const v = b as Partial<HotbarBinding> | undefined;
  return typeof v?.code === "string" &&
    typeof v.label === "string" &&
    hotbarKeyRefusal(v.code) === null
    ? { code: v.code, label: v.label }
    : undefined;
}

function load(): HotbarBindings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(raw)) return DEFAULT;
    return Array.from({ length: HOTBAR_SIZE }, (_, i): HotbarKeyPair => {
      const [key, second] = DEFAULT[i];
      // Saved with one key a slot: that one, and the second as it starts.
      const saved = Array.isArray(raw[i]) ? raw[i] : [raw[i], second];
      // Not `??`: a key saved empty stays empty.
      const first = parse(saved[0]);
      const next = parse(saved[1]);
      return [
        first === undefined ? key : first,
        next === undefined ? second : next,
      ];
    });
  } catch {
    return DEFAULT;
  }
}

let bindings = load();

function save(next: HotbarBindings) {
  bindings = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Kept until the app closes, then.
  }
  for (const l of listeners) l();
}

/** Put slot `i`'s key (`which` 0) or second key (1) on `binding`, or none. A
 * key presses one slot: wherever it was, it takes the key it replaces. */
export function setHotbarKey(
  i: number,
  which: 0 | 1,
  binding: HotbarBinding | null,
): void {
  const next = bindings.map(
    (pair) => [...pair] as [HotbarBinding | null, HotbarBinding | null],
  );
  const old = next[i][which];
  if (binding) {
    for (const [j, pair] of next.entries())
      for (const w of [0, 1] as const)
        if ((j !== i || w !== which) && pair[w]?.code === binding.code)
          pair[w] = old;
  }
  next[i][which] = binding;
  save(next);
}

export function resetHotbarKeys(): void {
  save(DEFAULT);
}

/** The slot `code` presses, or -1. */
export function hotbarSlotOfCode(code: string): number {
  return bindings.findIndex((pair) => pair.some((b) => b?.code === code));
}

export function useHotbarKeys(): HotbarBindings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => bindings,
  );
}
