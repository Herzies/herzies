// Medea: always in Town (no event, no schedule), selling sweets and potions —
// the consumables, which are eaten from the bank or a Town hotbar slot to heal.

/** Her name, in Town and on her stall. */
export const MEDEA_NAME = "Medea";

/** What opens her stall in Town (a card's openKey) and keys her spot on the
 * map. */
export const MEDEA_KEY = "medea";

/** What she sells, at what price in coins: no stock caps, no limits.
 * buy_from_medea (00113_medea_star_candy.sql) duplicates this list by hand;
 * keep the two in sync (medea.test.ts checks they agree). */
export const MEDEA_STOCK: readonly { itemId: string; price: number }[] = [
  { itemId: "star-candy", price: 20 },
];

/** The least time between two consumables eaten by one herzie. The Town
 * server holds a fight to it; the client to keep a held key from wasting a
 * stack. */
export const CONSUMABLE_COOLDOWN_MS = 1000;
