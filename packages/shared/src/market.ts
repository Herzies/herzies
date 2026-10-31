// The market board: a Town NPC who holds players' items on consignment. You
// list one copy at a fixed price, go away, and anyone can buy it while you're
// offline. Coins (less the market's cut) and anything unsold wait at the board
// until you come back and collect them.
//
// The rules live twice: here, and as constants in the market RPCs
// (00126_market_board.sql). market.test.ts checks the two agree.

/** His name, in Town and on his board. */
export const MARKET_NAME = "Plutus";

/** What opens the board in Town (a card's openKey) and keys his spot on the
 * map. */
export const MARKET_KEY = "market";

/** How many listings one player can have up at once. */
export const MARKET_MAX_LISTINGS = 6;

/** How long a listing stays up before it comes back unsold. */
export const MARKET_LISTING_HOURS = 48;

/** The highest price a listing can ask. */
export const MARKET_MAX_PRICE = 1_000_000;

/** The market's cut of a sale, in percent. It's a coin sink: it leaves the
 * economy rather than going to anyone. */
export const MARKET_FEE_PERCENT = 5;

/** The market's cut of a sale at `price`: never less than a coin. */
export function marketFee(price: number): number {
  return Math.max(1, Math.floor((price * MARKET_FEE_PERCENT) / 100));
}

/** What the seller collects from a sale at `price`. */
export function marketPayout(price: number): number {
  return price - marketFee(price);
}

/** The lowest price a copy can be listed at: one coin above what the game
 * pays for it, since anything less is better sold to the game. */
export function marketMinPrice(sellPrice: number | undefined): number {
  return (sellPrice ?? 0) + 1;
}

/** A listing as the board shows it. */
export interface MarketListing {
  id: string;
  sellerId: string;
  sellerName: string | null;
  itemId: string;
  upgradeLevel: number;
  price: number;
  fee: number;
  status: "active" | "sold" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  soldAt: string | null;
}

/** A player's own side of the board: what's up, and what's waiting. */
export interface MarketStall {
  /** Listings still for sale. */
  active: MarketListing[];
  /** Sold, cancelled or expired listings not yet collected. */
  uncollected: MarketListing[];
  /** Coins waiting: the sold listings' price less the market's cut. */
  coinsWaiting: number;
  /** Copies waiting to come back: the unsold listings. */
  itemsWaiting: number;
}
