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
