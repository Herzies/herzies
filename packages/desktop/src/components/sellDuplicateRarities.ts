import { RARITIES, type Rarity } from "@herzies/shared";

/**
 * Which rarities the bag's Sell duplicates may sell, as ticked in its
 * dialog, remembered on this machine (localStorage, which the app's webview
 * keeps across restarts and updates, as the hotbar's slots). Unset, it's
 * common and uncommon: the rarer ones are the likeliest to be wanted for a
 * trade, so selling their spares in bulk is something to opt into.
 */
const KEY = "herzies.bag.sellDuplicateRarities";

export const DEFAULT_SELL_DUPLICATE_RARITIES: readonly Rarity[] = [
  "common",
  "uncommon",
];

/** The saved choice, or the default if there's none (or it can't be read).
 * Rarities this app doesn't know are dropped; an empty choice is kept. */
export function loadSellDuplicateRarities(): ReadonlySet<Rarity> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed))
      return new Set(RARITIES.filter((r) => (parsed as unknown[]).includes(r)));
  } catch {
    // The default, then.
  }
  return new Set(DEFAULT_SELL_DUPLICATE_RARITIES);
}

/** Remembers `rarities` (best effort: storage may be full or off). */
export function saveSellDuplicateRarities(rarities: ReadonlySet<Rarity>): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(RARITIES.filter((r) => rarities.has(r))),
    );
  } catch {
    // Kept for this session only.
  }
}
