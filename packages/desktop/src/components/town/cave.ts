import { LOW_HP_FRACTION, liveHp } from "@herzies/shared";
import { useSyncExternalStore } from "react";
import { getVitals } from "./vitals";

/**
 * Whether the boss's cave is open, as the Town can tell from the events it
 * already polls; and the little messages it shows when you can't go in.
 * The server decides for real (a ticket for the cave is only issued while
 * the boss is up); this is so the door can say so before you try.
 */
export type CaveState =
  /** The boss is up until `endsAt` (ms since the epoch). */
  | { kind: "open"; endsAt: number }
  /** The boss arrives at `startsAt`. */
  | { kind: "soon"; startsAt: number }
  /** The boss has fallen. */
  | { kind: "defeated" }
  | { kind: "sealed" };

let state: CaveState = { kind: "sealed" };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function setCave(next: CaveState): void {
  const same =
    next.kind === state.kind &&
    (next.kind === "open"
      ? state.kind === "open" && next.endsAt === state.endsAt
      : next.kind === "soon"
        ? state.kind === "soon" && next.startsAt === state.startsAt
        : true);
  if (same) return;
  state = next;
  emit();
}

export function getCave(): CaveState {
  return state;
}

export function useCave(): CaveState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** `2:10:05`, or `34:12` under an hour. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** What the door says when it's shut. */
export function sealedMessage(c: CaveState, now = Date.now()): string {
  switch (c.kind) {
    case "soon":
      return `The lair is sealed. Something stirs in ${clock(c.startsAt - now)}.`;
    case "defeated":
      return "The lair is quiet. The boss has fallen.";
    case "sealed":
      return "The lair is sealed.";
    case "open":
      return "";
  }
}

// --- A line of text that shows for a moment -------------------------------

let toastText: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string, ms = 3_500): void {
  toastText = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastText = null;
    toastTimer = null;
    emit();
  }, ms);
  emit();
}

export function useToast(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toastText,
  );
}

// --- The door --------------------------------------------------------------

/** How long a "you're hurt" warning stays good for a second try, ms. */
const WARNING_MS = 6_000;
let warnedAt = Number.NEGATIVE_INFINITY;

/**
 * Whether to let the herzie into the cave now. Says why not when it won't.
 * Going in hurt (under half health) asks first: the first try only warns,
 * and a second within a few seconds goes in.
 */
export function tryEnterCave(now = Date.now()): boolean {
  if (state.kind !== "open") {
    showToast(sealedMessage(state, now));
    return false;
  }
  const v = getVitals();
  if (v && !v.down) {
    const hp = liveHp(v, now);
    if (hp / v.maxHp < LOW_HP_FRACTION && now - warnedAt > WARNING_MS) {
      warnedAt = now;
      showToast(
        `You're hurt (${Math.ceil(hp)} / ${v.maxHp}). Rest first, or go in again to enter anyway.`,
        WARNING_MS,
      );
      return false;
    }
  }
  return true;
}
