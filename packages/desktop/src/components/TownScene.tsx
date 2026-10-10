import {
  BOSS_BODY_TYPE,
  GEORGE_EQUIPPED,
  GEORGE_SEED,
  generateCreatureParams,
  NANDOR_EQUIPPED,
  NANDOR_SEED,
  ORPHIEZ_EQUIPPED,
  VISITORS,
} from "@herzies/shared";
import type { HerzieLook } from "@herzies/shared/gl";

export type EventCard = {
  type: string;
  title: string;
  description: string | null;
  status: "live" | "scheduled" | "idle";
  /** Ends-at when live, starts-at when scheduled. */
  at: string | null;
  detail?: string;
  /** What opening the card selects (an event id, or "song_hunt" for the hunt
   * view); null when there is nothing to open yet. */
  openKey: string | null;
  /** For a stable React key. */
  eventId?: string;
};

export function formatIn(at: string): string {
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/** A herzie's look, as the 3D model takes it. */
export type Look = HerzieLook;

/** The visitor's own look, the same one their screen shows. */
export function lookOf(card: EventCard): Look {
  switch (card.type) {
    case "song_hunt":
      return {
        seed: VISITORS.song_hunt.seed ?? "npc:orphiez",
        stage: 2,
        equipped: ORPHIEZ_EQUIPPED,
      };
    case "merchant":
      return { seed: GEORGE_SEED, stage: 2, equipped: GEORGE_EQUIPPED };
    case "treat_trader":
      return { seed: NANDOR_SEED, stage: 2, equipped: NANDOR_EQUIPPED };
    case "boss_fight": {
      const seed = `boss:${card.eventId ?? ""}`;
      return {
        seed,
        stage: 3,
        params: { ...generateCreatureParams(seed), bodyType: BOSS_BODY_TYPE },
      };
    }
    default:
      return { seed: `npc:${card.type}`, stage: 2 };
  }
}

/** The boss is in town but no longer standing. */
export const isDown = (card: EventCard) =>
  card.type === "boss_fight" && card.detail === "Defeated!";
