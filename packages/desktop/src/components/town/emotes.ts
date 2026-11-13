import {
  EMOTE_COOLDOWN_MS,
  emoteCooldownMs,
  type EmoteId,
  isEmoteId,
  ownedEmotes,
} from "@herzies/shared";
import { useSyncExternalStore } from "react";

/**
 * The emotes side of the Town: which you own (set from the app state by
 * main.tsx), whether Alt is held (which shows the Alt bar), and the emote
 * asked for, which the player's frame plays and sends (Player.tsx).
 */

let owned: EmoteId[] = [];
let altHeld = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The emotes owned, from the app state. Kept in catalog order: the Alt
 * bar's slots, Alt+1 first. Returns whether that changed anything. */
export function setOwnedEmotes(
  ids: readonly string[] | null | undefined,
): boolean {
  const next = ownedEmotes(ids);
  if (next.length === owned.length && next.every((id, i) => id === owned[i]))
    return false;
  owned = next;
  emit();
  return true;
}

export function useOwnedEmotes(): EmoteId[] {
  return useSyncExternalStore(subscribe, () => owned);
}

export function setAltHeld(on: boolean) {
  if (on === altHeld) return;
  altHeld = on;
  emit();
}

export function useAltHeld(): boolean {
  return useSyncExternalStore(subscribe, () => altHeld);
}

/** The emote waiting for the player's next frame (null: none). */
export const emoteRequest: { id: EmoteId | null } = { id: null };
/** When the last one played, and when each did (performance.now() ms). */
let lastPlayedAt = Number.NEGATIVE_INFINITY;
const playedAt = new Map<string, number>();

/** Asks for an emote you own: the player plays it on its next frame. Too
 * soon after the last one (the server drops those) does nothing. */
export function playEmote(id: string) {
  if (!isEmoteId(id) || !owned.includes(id)) return;
  const now = performance.now();
  if (now - lastPlayedAt < EMOTE_COOLDOWN_MS) return;
  // Its own cooldown, if it has one (a Mic Drop's mic is still on the floor).
  if (now - (playedAt.get(id) ?? Number.NEGATIVE_INFINITY) < emoteCooldownMs(id))
    return;
  emoteRequest.id = id;
}

/** The player played it: starts the cooldown. */
export function emotePlayed(id?: string) {
  lastPlayedAt = performance.now();
  if (id) playedAt.set(id, lastPlayedAt);
}

/** The Alt bar's slot `n` (1-based): the nth emote owned. */
export function emoteInSlot(n: number): EmoteId | undefined {
  return owned[n - 1];
}
