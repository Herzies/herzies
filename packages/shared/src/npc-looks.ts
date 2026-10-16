import {
  BOBOKU_SCHEME_ID,
  GOLD_SCHEME_ID,
  NANDOR_SCHEME_ID,
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
