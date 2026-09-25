import type { Equipped, ItemUnit } from "./items.js";

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

export interface Herzie {
  id: string;
  name: string;
  createdAt: string;

  appearance: HerzieAppearance;

  // Progression
  xp: number;
  level: number;
  stage: Stage;

  // Music stats
  totalMinutesListened: number;
  genreMinutes: Record<string, number>;

  // Social
  friendCode: string;
  friendCodes: string[];

  // Craving
  lastCravingDate: string;
  lastCravingGenre: string;

  // Boosts
  boostUntil?: number;

  // Streaks
  streakDays: number;
  streakLastDate: string | null;

  // Economy
  currency: number;
}

export interface HerzieProfile {
  name: string;
  friendCode: string;
  globalRank?: number;
  globalTotal?: number;
  stage: number;
  level: number;
  currency?: number;
  appearance?: HerzieAppearance;
  topArtists?: { name: string; plays: number }[];
  equipped?: Equipped;
  nowPlaying?: { title: string; artist: string; albumArtUrl?: string } | null;
  lastPlayed?: {
    title: string;
    artist: string;
    listenedAt: string;
    albumArtUrl?: string;
  } | null;
  songHuntWins?: number;
}

// --- Game Server API types ---

/** CLI → Server: heartbeat sync payload */
export interface SyncRequest {
  nowPlaying: {
    title: string;
    artist: string;
    genre?: string;
    albumArtUrl?: string;
  } | null;
  /** Minutes listened since last sync */
  minutesListened: number;
  /** Raw genre strings from the music player */
  genres: string[];
}

/** Server → CLI: sync response */
export interface SyncResponse {
  herzie: Herzie;
  /** Event notifications triggered by this sync */
  notifications: EventNotification[];
  /** Active multipliers (server-authoritative, includes both time-based and admin-managed) */
  multipliers: ActiveMultiplier[];
  /** Pending trade request from another player */
  pendingTradeRequest?: PendingTradeRequest;
  /** Newest incoming friend request you haven't responded to (drives the overlay + notification) */
  pendingFriendRequest?: PendingFriendRequest;
  /** Friend requests sent to you that are still pending */
  incomingFriendRequests: FriendRequestSummary[];
  /** Friend requests you sent that are still pending */
  outgoingFriendRequests: FriendRequestSummary[];
  /** World drops waiting to be collected. Each persists until collected (no
   * expiry) — any number can be pending at once. */
  pendingDrops: PendingDrop[];
  /** Every owned copy of every item, each with its own upgrade level and worn
   * slot. The source of truth: `inventory`, `equipped` and `itemUpgrades`
   * below are derived from these and only remain for clients that predate
   * them. Omitted when they couldn't be read — a client keeps what it has
   * rather than treating that as an empty inventory. */
  units?: ItemUnit[];
  /** Authoritative inventory. Carried here so clients get it on the regular
   * sync cadence instead of re-fetching /inventory after every mutation: the
   * herzies row is already loaded to build this response, so including it
   * costs no extra query. Reflects any grants or Spirit Orb auto-collects
   * this same sync performed. */
  inventory: Inventory;
  /** Authoritative equip state, carried for the same reason as `inventory`. */
  equipped: Equipped;
  /** Dice-upgrade levels (itemId -> 0-3), carried for the same reason as
   * `inventory` — see applyItemUpgrade / MAX_ITEM_UPGRADE_LEVEL. */
  itemUpgrades: Record<string, number>;
}

/** Notification that another player wants to trade */
export interface PendingTradeRequest {
  tradeId: string;
  fromName: string;
  fromFriendCode: string;
}

/** A world drop waiting to be collected — removed from the list once picked
 * up (manually, by id, or automatically by an equipped Spirit Orb). */
export interface PendingDrop {
  id: string;
  itemId: string;
  droppedAt: string;
}

/** Notification that another player wants to be your friend */
export interface PendingFriendRequest {
  requestId: string;
  fromName: string;
  fromFriendCode: string;
}

/** A pending friend request (incoming or outgoing) */
export interface FriendRequestSummary {
  requestId: string;
  friendCode: string;
  name: string;
  createdAt: string;
}

/** A result from searching for a herzie to befriend */
export interface FriendSearchResult {
  friendCode: string;
  name: string;
  level: number;
  relationship: "none" | "friends" | "pending_sent" | "pending_received";
}

/** A multiplier that boosts XP gain */
export interface ActiveMultiplier {
  name: string;
  /** Bonus as a fraction, e.g. 1.0 = +100%, 0.2 = +20% */
  bonus: number;
}

export interface EventNotification {
  type: "item_granted" | "event_complete" | "info";
  title: string;
  message: string;
  itemId?: string;
  quantity?: number;
  /** When true, the desktop client logs this in the activity feed only and skips the native OS popup. */
  logOnly?: boolean;
}

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

/** Secret track event config shape */
export interface SecretTrackConfig {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  maxClaims: number;
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

/** Audio playback state for a hint, as seen by a specific user (server-computed). */
export interface SongHuntHintAudioState {
  hasAudio: true;
  playsRemaining: number;
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

/**
 * Boss fight config as stored in `events.config`.
 *
 * `hatedGenres` holds values from GENRES, not raw listener tags. "techno" is
 * not a Genre — classifyGenre maps techno/house/edm/dubstep onto "electronic",
 * so a techno boss is stored as `["electronic"]` and is also hurt by the rest
 * of that family. The spawner never rolls "pop", which is the fallback for
 * every unmatched tag and would make the boss take damage from everything.
 */
export interface BossFightConfig {
  hatedGenres: Genre[];
  rewardItemId: string;
  topRewardItemId?: string;
  /** How many top dealers also get the rarer reward. */
  topCount: number;
  maxHp: number;
}

/**
 * Damage a listen deals to a boss, per billed minute, whichever hated genre it
 * matches. `processSync` multiplies billed minutes by this and the desktop
 * shows it on the red genre pills, so the tooltip cannot disagree with the
 * fight.
 */
export const BOSS_DAMAGE_PER_MINUTE = 1;

export interface BossDamageDealer {
  name: string;
  damage: number;
  rank: number;
}

/**
 * What a client actually receives for a boss_fight event. Live HP and the
 * leaderboard are read server-side and projected in — clients cannot read
 * `events`, `boss_state` or `boss_damage` directly (00016, 00073).
 */
export interface BossFightView {
  hatedGenres: Genre[];
  /**
   * Withheld until the boss is dead — the reward is part of the mystery, and
   * hiding it only in the UI would leave it readable in the response.
   */
  rewardItemId?: string;
  topRewardItemId?: string;
  topCount: number;
  hp: number;
  maxHp: number;
  killed: boolean;
  escaped: boolean;
  topDealers: BossDamageDealer[];
  /** The requesting user's own contribution, so the UI can show "you". */
  yourDamage: number;
  yourRank: number | null;
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

// --- Inventory & Economy types ---

/** Inventory as a map of item ID to quantity */
export type Inventory = Record<string, number>;

/** One copy in a trade offer, snapshotted with what the other side needs to
 * judge it — its level — so they can see "+3 Box of Boom" before accepting
 * without a live look into the offerer's inventory. */
export interface OfferedUnit {
  unitId: string;
  itemId: string;
  upgradeLevel: number;
}

/** One side of a trade offer. */
export interface TradeOffer {
  /** The copies being given. Absent on an offer made before copies existed. */
  units?: OfferedUnit[];
  /** The same offer counted by item id — the only thing an offer from before
   * copies existed has, and still filled in for clients that read only this. */
  items: Record<string, number>;
  currency: number;
}

export type TradeState =
  | "pending"
  | "active"
  | "initiator_locked"
  | "target_locked"
  | "both_locked"
  | "completed"
  | "cancelled";

/** A purchasable currency pack in the store. */
export interface StoreProduct {
  id: string;
  name: string;
  description: string | null;
  currencyAmount: number;
  priceNokOre: number;
}

/**
 * A catalog item sold for real money rather than coins.
 *
 * Carries no name, art or description: the client already has all of that in
 * its own item catalog under `itemId`, and duplicating it here would create a
 * second copy to drift out of sync. Stripe owns the price, the catalog owns
 * the presentation, and `itemId` is the join.
 */
export interface PremiumItem {
  itemId: string;
  priceId: string;
  /** Minor units of `currency` (e.g. 3900 = 39.00). Never assumed to be NOK. */
  amount: number;
  /** ISO 4217 code, lowercase, as Stripe returns it. */
  currency: string;
}

export interface Trade {
  id: string;
  initiatorId: string;
  targetId: string;
  initiatorName: string;
  targetName: string;
  initiatorOffer: TradeOffer;
  targetOffer: TradeOffer;
  state: TradeState;
  initiatorAccepted: boolean;
  targetAccepted: boolean;
  createdAt: string;
  expiresAt: string;
}
