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
  equipped?: string[];
  nowPlaying?: { title: string; artist: string } | null;
  lastPlayed?: {
    title: string;
    artist: string;
    listenedAt: string;
  } | null;
}

// --- Game Server API types ---

/** CLI → Server: heartbeat sync payload */
export interface SyncRequest {
  nowPlaying: { title: string; artist: string; genre?: string } | null;
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
}

/** Notification that another player wants to trade */
export interface PendingTradeRequest {
  tradeId: string;
  fromName: string;
  fromFriendCode: string;
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

/** One side of a trade offer */
export interface TradeOffer {
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
