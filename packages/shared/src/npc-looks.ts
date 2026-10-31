import {
  BOBOKU_SCHEME_ID,
  GOLD_SCHEME_ID,
  MEDEA_SCHEME_ID,
  NANDOR_SCHEME_ID,
  TOWER_GUARD_SCHEME_ID,
} from "./creature-renderer.js";
import type { Equipped } from "./items.js";

// How the Town's visitors look, shared so the desktop and the website draw
// the same characters. Seeds are fixed NPC seeds (never a real user id), so a
// visitor looks the same for everyone. The boss has no fixed look: each boss
// is seeded from its own event (`boss:<event id>`).

/** George's look: one fixed seed, painted solid gold, because George is rich
 * and wants you to know it. */
export const GEORGE_SEED = "npc:good-ol-george";
export const GEORGE_EQUIPPED: Equipped = { color: GOLD_SCHEME_ID };

/** Orphiez's look: a fixed seed like George's (VISITORS.song_hunt.seed), in
 * the teal skin, with headphones on — he's listening for it everywhere. */
export const ORPHIEZ_EQUIPPED: Equipped = {
  head: "headphones",
  color: "thanks-for-all-the-fish",
};

/** Nandor the Treatless's look: a vampire, so fangs on a pale face over a
 * blood-red cloak (NANDOR_RAMP). */
export const NANDOR_SEED = "npc:nandor-the-treatless";
export const NANDOR_EQUIPPED: Equipped = {
  face: "fangs",
  color: NANDOR_SCHEME_ID,
};

/** Boboku's look: grown up (stage 3), orange, in a tweed sixpence and ur
 * mom's favourite bowtie. */
export const BOBOKU_SEED = "npc:boboku";
export const BOBOKU_STAGE = 3;
export const BOBOKU_EQUIPPED: Equipped = {
  head: "sixpence",
  body: "bowtie",
  color: BOBOKU_SCHEME_ID,
};

/** Medea's look: stage 2, candy pink sinking to plum (MEDEA_RAMP). */
export const MEDEA_SEED = "npc:medea";
export const MEDEA_STAGE = 2;
export const MEDEA_EQUIPPED: Equipped = { color: MEDEA_SCHEME_ID };

/** The Tower Guard's look: grown up (stage 3), in navy, under a steel helm
 * with a red crest. */
export const TOWER_GUARD_SEED = "npc:tower-guard";
export const TOWER_GUARD_STAGE = 3;
export const TOWER_GUARD_EQUIPPED: Equipped = {
  head: "guard-helm",
  color: TOWER_GUARD_SCHEME_ID,
};

/** Plutus's look: grown up (stage 3), in violet, with pearls at his throat
 * and a troubadour's mantle: he's seen every instrument in Town change
 * hands. */
export const MARKET_SEED = "npc:plutus";
export const MARKET_STAGE = 3;
export const MARKET_EQUIPPED: Equipped = {
  body: "pearl-necklace",
  back: "troubadour-mantle",
  color: "purple-dane",
};
