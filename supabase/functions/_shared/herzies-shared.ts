/**
 * Deno-native shim for the `@herzies/shared` pure helpers.
 *
 * The vendored `./game-server.ts` needs a handful of pure helpers from
 * `@herzies/shared` (XP/leveling, cravings, genre classification). That
 * package's source uses NodeNext `.js` import specifiers and barrels in React
 * components, neither of which resolve cleanly under Deno, and the Supabase
 * runtime can't reach the monorepo package anyway. So we vendor just those
 * helpers here. They're small, stable, and dependency-free.
 *
 * PRODUCTION PATH: publish `@herzies/shared` (and the game-server logic) to
 * npm/JSR with a server-safe entrypoint and import it by name from both the
 * Next.js route and this function, deleting this shim and the vendored copy.
 */

// ---------------------------------------------------------------------------
// Types (mirror of packages/shared/src/types.ts — the subset game-server uses)
// ---------------------------------------------------------------------------

export type ColorScheme =
  | "pink"
  | "blue"
  | "green"
  | "purple"
  | "orange"
  | "yellow"
  | "cyan"
  | "red";

export type Stage = 1 | 2 | 3;

export interface HerzieAppearance {
  headIndex: number;
  eyesIndex: number;
  mouthIndex: number;
  accessoryIndex: number;
  limbsIndex: number;
  bodyIndex: number;
  legsIndex: number;
  colorScheme: ColorScheme;
}

export interface Herzie {
  id: string;
  name: string;
  createdAt: string;
  appearance: HerzieAppearance;
  xp: number;
  level: number;
  stage: Stage;
  totalMinutesListened: number;
  genreMinutes: Record<string, number>;
  friendCode: string;
  friendCodes: string[];
  lastCravingDate: string;
  lastCravingGenre: string;
  boostUntil?: number;
  streakDays: number;
  streakLastDate: string | null;
  currency: number;
}

export interface ActiveMultiplier {
  name: string;
  bonus: number;
}

export interface EventNotification {
  type: "item_granted" | "event_complete" | "info";
  title: string;
  message: string;
  itemId?: string;
  quantity?: number;
  logOnly?: boolean;
}

export interface PendingTradeRequest {
  tradeId: string;
  fromName: string;
  fromFriendCode: string;
}

export interface PendingFriendRequest {
  requestId: string;
  fromName: string;
  fromFriendCode: string;
}

/** A world drop waiting to be collected — removed from the list once picked
 * up (manually, by id, or automatically by an equipped Spirit Orb). Mirror
 * of packages/shared/src/types.ts. */
export interface PendingDrop {
  id: string;
  itemId: string;
  droppedAt: string;
}

/** Mirror of packages/shared/src/items.ts's Rarity. */
export type Rarity = "common" | "uncommon" | "rare" | "legendary";

/** Relative weight for random world drops — common is heaviest, legendary
 * lightest. Mirror of packages/shared/src/items.ts's RARITY_DROP_WEIGHTS. */
export const RARITY_DROP_WEIGHTS: Record<Rarity, number> = {
  common: 100,
  uncommon: 30,
  rare: 8,
  legendary: 1,
};

/** Items that can never appear as a random world drop, regardless of rarity.
 * Mirror of packages/shared/src/items.ts's NON_DROPPABLE_ITEM_IDS. */
export const NON_DROPPABLE_ITEM_IDS = ["first-edition", "spirit-orb"] as const;

/** Chance a drop is rolled on each eligible listening tick. Mirror of
 * packages/shared/src/items.ts's DROP_CHANCE_PER_TICK. 1 = guaranteed. */
export const DROP_CHANCE_PER_TICK = 1;

/** Per-item drop-weight overrides. Mirror of packages/shared/src/items.ts's
 * ITEM_DROP_WEIGHT_OVERRIDES. */
export const ITEM_DROP_WEIGHT_OVERRIDES: Partial<Record<string, number>> = {
  cd: 400,
};

/** Weighted-random pick from a rarity-tagged candidate pool. Mirror of
 * packages/shared/src/items.ts's pickWeightedDrop. */
export function pickWeightedDrop<T extends { id: string; rarity: Rarity }>(
  candidates: T[],
  rng: () => number = Math.random,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const weights = candidates.map(
    (c) => ITEM_DROP_WEIGHT_OVERRIDES[c.id] ?? RARITY_DROP_WEIGHTS[c.rarity],
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** Every item id in packages/shared/src/items.ts's ITEMS catalog. Kept as a
 * plain id list (not the full ItemDef catalog, which generates ASCII card art
 * at module load — wasted cold-start cost in a function that never renders
 * cards) so filterDroppablePool below can validate DB rows against it.
 *
 * MUST be updated whenever an item is added to or removed from ITEMS — same
 * "keep this in sync" obligation as the rest of this file. An id present in
 * the `items` table but missing here (or vice versa) is exactly the drift
 * this list exists to catch: see filterDroppablePool. */
const KNOWN_ITEM_IDS = new Set([
  "first-edition",
  "cd",
  "headphones",
  "rainbow-headband",
  "boombox",
  "good-eye-sniper",
  "clouds",
  "stars",
  "prism",
  "poseidons-gift",
  "spirit-orb",
]);

/** Filters raw {id, rarity} rows fetched from the `items` DB table down to
 * ones that are both a known catalog item and have a rarity recognized by
 * RARITY_DROP_WEIGHTS. Mirror of packages/shared/src/items.ts's
 * filterDroppablePool — see its doc comment for why this matters (an
 * unrecognized id/rarity would otherwise silently and permanently block a
 * user's world-drop slot, since a pending drop is never overwritten). */
export function filterDroppablePool<T extends { id: string; rarity: string }>(
  rows: T[],
): (T & { rarity: Rarity })[] {
  return rows.filter(
    (r): r is T & { rarity: Rarity } =>
      KNOWN_ITEM_IDS.has(r.id) && r.rarity in RARITY_DROP_WEIGHTS,
  );
}

export interface FriendRequestSummary {
  requestId: string;
  friendCode: string;
  name: string;
  createdAt: string;
}

export interface SecretTrackConfig {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  maxClaims: number;
}

export const GENRES = [
  "pop",
  "rock",
  "hip-hop",
  "electronic",
  "jazz",
  "classical",
  "r&b",
  "country",
  "metal",
  "indie",
  "latin",
  "folk",
  "blues",
  "punk",
  "soul",
] as const;

export type Genre = (typeof GENRES)[number];

// ---------------------------------------------------------------------------
// Leveling (mirror of packages/shared/src/leveling.ts)
// ---------------------------------------------------------------------------

export function xpForLevel(level: number): number {
  return Math.floor(100 * level ** 1.5);
}

export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let i = 2; i <= level; i++) {
    total += xpForLevel(i);
  }
  return total;
}

export function stageForLevel(level: number): Stage {
  if (level >= 25) return 3;
  if (level >= 10) return 2;
  return 1;
}

const BASE_XP_PER_MINUTE = 10;

export function calculateXpGain(
  minutes: number,
  friendCount: number,
  isCravingGenre: boolean,
  multipliers: ActiveMultiplier[],
): number {
  let xp = minutes * BASE_XP_PER_MINUTE;
  const friendBonus = Math.min(friendCount, 20) * 0.02;
  xp *= 1 + friendBonus;
  if (isCravingGenre) {
    xp *= 1.5;
  }
  if (multipliers.length > 0) {
    const totalBonus = multipliers.reduce((sum, m) => sum + m.bonus, 0);
    xp *= 1 + totalBonus;
  }
  return xp;
}

/** +2% XP per song hunt won while Good Eye Sniper is equipped, capped at +30% (15 wins). */
const GOOD_EYE_SNIPER_XP_PER_WIN = 0.02;
const GOOD_EYE_SNIPER_XP_CAP = 0.3;

export function goodEyeSniperBonus(songHuntWins: number): number {
  return Math.min(
    songHuntWins * GOOD_EYE_SNIPER_XP_PER_WIN,
    GOOD_EYE_SNIPER_XP_CAP,
  );
}

export function applyXp(
  herzie: Herzie,
  xpGain: number,
): { leveledUp: boolean; evolved: boolean; newStage?: Stage } {
  herzie.xp += xpGain;
  let leveledUp = false;
  let evolved = false;
  let newStage: Stage | undefined;
  while (herzie.xp >= totalXpForLevel(herzie.level + 1)) {
    herzie.level++;
    leveledUp = true;
    const stage = stageForLevel(herzie.level);
    if (stage !== herzie.stage) {
      herzie.stage = stage;
      evolved = true;
      newStage = stage;
    }
  }
  return { leveledUp, evolved, newStage };
}

// ---------------------------------------------------------------------------
// Craving (mirror of packages/shared/src/craving.ts)
// ---------------------------------------------------------------------------

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyCraving(herzieId: string, date?: string): Genre {
  const dateStr = date ?? todayString();
  const seed = simpleHash(herzieId + dateStr);
  const index = seed % GENRES.length;
  return GENRES[index];
}

export function matchesCraving(
  trackGenres: string[],
  cravingGenre: Genre,
): boolean {
  const craving = cravingGenre.toLowerCase();
  return trackGenres.some((g) => {
    const genre = g.toLowerCase();
    return genre.includes(craving) || craving.includes(genre);
  });
}

// ---------------------------------------------------------------------------
// Genres (mirror of packages/shared/src/genres.ts)
// ---------------------------------------------------------------------------

export function classifyGenre(spotifyGenres: string[]): Genre[] {
  const matched = new Set<Genre>();

  for (const raw of spotifyGenres) {
    const lower = raw.toLowerCase();

    for (const genre of GENRES) {
      if (lower.includes(genre) || genre.includes(lower)) {
        matched.add(genre);
      }
    }

    if (
      lower.includes("rap") ||
      lower.includes("trap") ||
      lower.includes("drill")
    ) {
      matched.add("hip-hop");
    }
    if (
      lower.includes("edm") ||
      lower.includes("house") ||
      lower.includes("techno") ||
      lower.includes("dubstep")
    ) {
      matched.add("electronic");
    }
    if (
      lower.includes("alt") ||
      lower.includes("shoegaze") ||
      lower.includes("dream pop")
    ) {
      matched.add("indie");
    }
    if (
      lower.includes("hardcore") ||
      lower.includes("death") ||
      lower.includes("thrash")
    ) {
      matched.add("metal");
    }
    if (
      lower.includes("reggaeton") ||
      lower.includes("salsa") ||
      lower.includes("bachata")
    ) {
      matched.add("latin");
    }
    if (lower.includes("rhythm") || lower.includes("rnb")) {
      matched.add("r&b");
    }
  }

  return matched.size > 0 ? [...matched] : ["pop"];
}

export function recordGenreMinutes(
  genreMinutes: Record<string, number>,
  genres: Genre[],
  minutes: number,
): void {
  const perGenre = minutes / (genres.length || 1);
  for (const genre of genres) {
    genreMinutes[genre] = (genreMinutes[genre] ?? 0) + perGenre;
  }
}

// ---------------------------------------------------------------------------
// Event types (mirror of packages/shared/src/types.ts — the subset the
// `events-active` function's vendored `events.ts` uses)
// ---------------------------------------------------------------------------

/** A game event (secret track challenge, etc.) */
export interface GameEvent {
  id: string;
  type: string;
  title: string;
  description: string | null;
  active: boolean;
  startsAt: string;
  endsAt: string;
  config: Record<string, unknown>;
}

export interface SongHuntHint {
  text: string;
  /** ISO date string — hint becomes readable after this time (UTC) */
  unlocksAt: string;
  /**
   * Storage object key of an optional audio snippet attached to this hint
   * (in the private `hint-audio` bucket). Never sent to clients directly —
   * only used server-side to resolve playback via /api/events/hint-audio/play.
   */
  audioKey?: string;
}

export interface SongHuntConfig {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  maxClaims: number;
  hints: SongHuntHint[];
}

export interface SongHuntFinder {
  name: string;
  claimedAt: string;
}

// --- Bank capacity ---------------------------------------------------------
// Vendored from `packages/shared/src/items.ts` (see this file's header for why
// a copy is needed). Keep in sync with that copy — in particular
// BANK_SLOT_COUNT, which the desktop grid also derives its 6x3 layout from.

/** Fixed bank capacity in the desktop Cards grid. */
export const BANK_SLOT_COUNT = 18;

/** The only two item facts bank-slot counting needs. */
export interface BankItemInfo {
  stackable?: boolean;
  category: "deck" | "misc";
}

export type BankItemLookup = (itemId: string) => BankItemInfo | undefined;

/** One slot per stackable id owned (any quantity), plus one per unit of a
 * non-stackable — except whatever is equipped, which reserves a unit as "worn"
 * and frees its bank slot. */
export function bankSlotsUsed(
  inventory: Record<string, number> | null | undefined,
  equipped: Record<string, unknown> | null | undefined,
  lookup: BankItemLookup,
): number {
  if (!inventory) return 0;
  const e = (equipped ?? {}) as Record<string, unknown>;
  const modifiers = Array.isArray(e.modifier) ? (e.modifier as string[]) : [];
  const isEquipped = (itemId: string) =>
    Object.entries(e).some(
      ([slot, value]) => slot !== "modifier" && value === itemId,
    ) || modifiers.includes(itemId);

  let count = 0;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (qty <= 0) continue;
    const item = lookup(itemId);
    if (item && item.category !== "deck") continue;
    const worn = isEquipped(itemId);
    if (item?.stackable) {
      if (!worn) count += 1;
      continue;
    }
    count += Math.max(0, worn ? qty - 1 : qty);
  }
  return count;
}

/** Whether one more of `itemId` would fit. Not the same as "is the bank full":
 * another copy of an already-stacked item shares its slot and still fits. */
export function hasRoomFor(
  inventory: Record<string, number> | null | undefined,
  equipped: Record<string, unknown> | null | undefined,
  itemId: string,
  lookup: BankItemLookup,
): boolean {
  const current = inventory ?? {};
  const next = { ...current, [itemId]: (current[itemId] ?? 0) + 1 };
  return bankSlotsUsed(next, equipped, lookup) <= BANK_SLOT_COUNT;
}
