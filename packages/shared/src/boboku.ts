// Boboku: always in Town (no event, no schedule), selling the basic class
// instruments. Anyone can buy any of them; only the right class can equip
// one. Now that instruments break on a failed risky dice roll, he's where a
// broken one is replaced. He also sells a spare of his own flat cap, the
// Vagrant Cap.

/** His name, in Town and on his stall. */
export const BOBOKU_NAME = "Boboku";

/** What opens his stall in Town (a card's openKey) and keys his spot on the
 * map. */
export const BOBOKU_KEY = "boboku";

/** What he sells, at what price in coins: no stock caps, no limits.
 * buy_from_boboku (last replaced in 00127_vagrant_cap.sql) duplicates this
 * list by hand; keep the two in sync (boboku.test.ts checks they agree). */
export const BOBOKU_STOCK: readonly { itemId: string; price: number }[] = [
  { itemId: "lute", price: 100 },
  { itemId: "compact-discs", price: 100 },
  { itemId: "worn-stick", price: 100 },
  { itemId: "old-cymbal", price: 100 },
  { itemId: "sixpence", price: 300 },
];
