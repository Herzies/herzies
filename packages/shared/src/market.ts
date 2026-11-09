// The market board: a Town NPC who holds players' items on consignment. You
// list one copy at a fixed price, go away, and anyone can buy it while you're
// offline. Coins (less the market's cut) and anything unsold wait at the board
// until you come back and collect them.
//
// The rules live twice: here, and as constants in the market RPCs
// (last in 00146_market_partial_buys.sql). market.test.ts checks the two agree.

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

/** The most copies of a stackable item one listing can hold. */
export const MARKET_MAX_STACK = 999;

/** The lowest price a copy can be listed at, whatever the game pays: at 1
 * coin the market's cut would be the whole price. */
export const MARKET_MIN_EACH = 2;

/** The lowest price `quantity` copies can be listed at: one coin a copy
 * above what the game pays, since anything less is better sold to the game,
 * and never under MARKET_MIN_EACH a copy. */
export function marketMinPrice(
  sellPrice: number | undefined,
  quantity = 1,
): number {
  return Math.max((sellPrice ?? 0) + 1, MARKET_MIN_EACH) * quantity;
}

/** The highest price a copy can ask in a stack of `quantity`, keeping the
 * whole listing under MARKET_MAX_PRICE. */
export function marketMaxEach(quantity = 1): number {
  return Math.floor(MARKET_MAX_PRICE / Math.max(1, quantity));
}

/** What one copy of a stack costs when it can be bought a few at a time, or
 * null when the listing sells only whole: its price doesn't split evenly
 * across its copies (a lot priced as one), or a copy would cost under
 * MARKET_MIN_EACH. A single copy is just its price. Kept in step with
 * market_buy (00146). */
export function marketPriceEach(l: {
  price: number;
  quantity: number;
}): number | null {
  if (l.quantity <= 1) return l.price;
  if (l.price % l.quantity !== 0) return null;
  const each = l.price / l.quantity;
  return each >= MARKET_MIN_EACH ? each : null;
}

/** What buying `count` copies of a listing costs. */
export function marketCost(
  l: { price: number; quantity: number },
  count: number,
): number {
  if (count >= l.quantity) return l.price;
  return (marketPriceEach(l) ?? l.price) * count;
}

/** A listing as the board shows it. */
export interface MarketListing {
  id: string;
  sellerId: string;
  sellerName: string | null;
  itemId: string;
  upgradeLevel: number;
  /** Copies in the listing: more than 1 only for a stackable item. */
  quantity: number;
  /** For the whole listing, every copy. See marketPriceEach for buying
   * part of a stack. */
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
  /** Copies waiting to come back: every copy in the unsold listings. */
  itemsWaiting: number;
}
